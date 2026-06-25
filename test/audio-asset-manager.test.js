const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function createLoggerStub() {
  return {
    warn: () => {},
    info: () => {},
    error: () => {},
    child: () => createLoggerStub(),
  };
}

// Minimal but signature-valid WAV buffer ("RIFF"...."WAVE").
function wavBuffer(extraBytes = 64) {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WAVE'),
    Buffer.alloc(extraBytes),
  ]);
}

function loadManager(audioDir, idSequence) {
  let counter = 0;
  return loadWithMocks(
    path.join(__dirname, '..', 'src', 'Modules', 'AudioAssetManager', 'index.js'),
    {
      '../Logger': { CreateLogger: () => createLoggerStub() },
      '../AppData': { Manager: { GetAudioDirectory: () => audioDir } },
      '../UUID': {
        Manager: {
          Generate: () => (idSequence ? idSequence[counter++] : `id-${counter++}`),
        },
      },
    }
  );
}

test('AudioAssetManager imports, validates, updates and deletes assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-audio-'));
  const audioDir = path.join(root, 'Audio');
  const sourceDir = path.join(root, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });

  const sourceWav = path.join(sourceDir, 'My Clip!.wav');
  fs.writeFileSync(sourceWav, wavBuffer());

  const { Manager } = loadManager(audioDir, ['asset-1']);

  await Manager.Init();
  const [, emptyList] = await Manager.GetAll();
  assert.deepEqual(emptyList, []);

  // Inspection derives an alphanumeric default label from the file name.
  const inspection = Manager.InspectCandidate(sourceWav);
  assert.equal(inspection.Error, null);
  assert.equal(inspection.BaseLabel, 'MyClip');
  assert.equal(inspection.Extension, 'wav');
  assert.ok(inspection.DataURL.startsWith('data:audio/wav;base64,'));

  const [importErr, asset] = await Manager.Import({
    SourcePath: sourceWav,
    Volume: 250, // clamped to 200
    Duration: 4,
  });
  assert.equal(importErr, null);
  assert.equal(asset.ID, 'asset-1');
  assert.equal(asset.Label, 'MyClip');
  assert.equal(asset.Volume, 200);
  assert.equal(asset.Missing, false);

  // File copied into the store and manifest persisted.
  assert.ok(fs.existsSync(path.join(audioDir, 'asset-1.wav')));
  assert.ok(fs.existsSync(path.join(audioDir, 'manifest.json')));

  assert.equal(Manager.Exists('asset-1'), true);
  assert.deepEqual(Manager.FindMissing(['asset-1', 'nope']), ['nope']);

  const [dataErr, dataPayload] = Manager.GetDataURL('asset-1');
  assert.equal(dataErr, null);
  assert.ok(dataPayload.DataURL.startsWith('data:audio/wav;base64,'));

  const [updateErr, updated] = await Manager.Update('asset-1', {
    Label: 'Hello World 123!!',
    Volume: 50,
  });
  assert.equal(updateErr, null);
  assert.equal(updated.Label, 'HelloWorld123');
  assert.equal(updated.Volume, 50);

  const [deleteErr] = await Manager.Delete('asset-1');
  assert.equal(deleteErr, null);
  assert.equal(fs.existsSync(path.join(audioDir, 'asset-1.wav')), false);
  assert.equal(Manager.Exists('asset-1'), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('AudioAssetManager rejects invalid candidates and long audio', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-audio-'));
  const audioDir = path.join(root, 'Audio');
  const sourceDir = path.join(root, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });

  const { Manager } = loadManager(audioDir, ['asset-x']);
  await Manager.Init();

  // Unsupported extension.
  const txt = path.join(sourceDir, 'note.txt');
  fs.writeFileSync(txt, 'hello');
  assert.match(Manager.InspectCandidate(txt).Error, /Unsupported file type/);

  // Valid extension but non-audio content (bad magic bytes).
  const fakeWav = path.join(sourceDir, 'fake.wav');
  fs.writeFileSync(fakeWav, Buffer.from('not really audio data here'));
  assert.match(Manager.InspectCandidate(fakeWav).Error, /valid audio file/);

  // Real audio but too long -> rejected at import.
  const longWav = path.join(sourceDir, 'long.wav');
  fs.writeFileSync(longWav, wavBuffer());
  const [err] = await Manager.Import({ SourcePath: longWav, Duration: 30 });
  assert.match(err, /shorter than 15 seconds/);

  fs.rmSync(root, { recursive: true, force: true });
});
