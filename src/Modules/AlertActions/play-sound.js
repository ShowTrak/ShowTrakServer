const { Manager: BroadcastManager } = require('../Broadcast');

const ID = 'play-sound';

const SOUND_OPTIONS = [
  { Value: 'Notification', Label: 'Notification' },
  { Value: 'Alert', Label: 'Alert' },
  { Value: 'Warning', Label: 'Warning' },
];

const ALLOWED_SOUNDS = SOUND_OPTIONS.map((Option) => Option.Value);

const Settings = [
  {
    Key: 'Sound',
    Label: 'Sound',
    Type: 'select',
    Options: SOUND_OPTIONS,
    Default: 'Notification',
    Preview: 'sound',
  },
];

function NormalizeSettings(Input) {
  const Next = Input && typeof Input === 'object' ? Input : {};
  const Sound = ALLOWED_SOUNDS.includes(Next.Sound) ? Next.Sound : 'Notification';
  return { Sound };
}

function ValidateSettings(SettingsInput) {
  NormalizeSettings(SettingsInput);
  return true;
}

async function Execute(Action, _Context, Logger) {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});
  BroadcastManager.emit('PlaySound', S.Sound);
  Logger.info(`Play sound alert action queued (${S.Sound})`);
  return { Success: true };
}

module.exports = {
  ID,
  Name: 'Play Alert Sound',
  Description: 'Plays one of the built-in ShowTrak alert sounds on the server.',
  Settings,
  NormalizeSettings,
  ValidateSettings,
  Execute,
};
