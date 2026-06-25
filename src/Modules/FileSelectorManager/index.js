// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('FileSelector');

const { dialog } = require('electron');

const Manager = {};

const SHOWTRAK_FILE_FILTER = {
  name: 'ShowTrak File',
  extensions: ['ShowTrak'],
};

const AUDIO_FILE_FILTER = {
  name: 'Audio Files',
  extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'],
};

Manager.OpenDialog = async (Title) => {
  return await dialog.showOpenDialog({
    title: Title,
    filters: [SHOWTRAK_FILE_FILTER],
    properties: ['openFile'],
    message: Title,
  });
};

Manager.OpenAudioDialog = async (Title) => {
  return await dialog.showOpenDialog({
    title: Title,
    filters: [AUDIO_FILE_FILTER],
    properties: ['openFile', 'multiSelections'],
    message: Title,
  });
};

Manager.SaveDialog = async (Title) => {
  let CurrentDatestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 10);
  return await dialog.showSaveDialog({
    title: Title,
    defaultPath: `ShowTrak ${CurrentDatestamp}.ShowTrak`,
    filters: [SHOWTRAK_FILE_FILTER],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
};

module.exports = {
  Manager,
};
