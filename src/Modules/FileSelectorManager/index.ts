const { dialog } = require('electron');

const SHOWTRAK_FILE_FILTER = {
  name: 'ShowTrak File',
  extensions: ['ShowTrak'],
};

const AUDIO_FILE_FILTER = {
  name: 'Audio Files',
  extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'],
};

export const Manager = {
  async OpenDialog(Title: string) {
    return await dialog.showOpenDialog({
      title: Title,
      filters: [SHOWTRAK_FILE_FILTER],
      properties: ['openFile'],
      message: Title,
    });
  },

  async OpenAudioDialog(Title: string) {
    return await dialog.showOpenDialog({
      title: Title,
      filters: [AUDIO_FILE_FILTER],
      properties: ['openFile', 'multiSelections'],
      message: Title,
    });
  },

  async SaveDialog(Title: string) {
    const CurrentDatestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 10);
    return await dialog.showSaveDialog({
      title: Title,
      defaultPath: `ShowTrak ${CurrentDatestamp}.ShowTrak`,
      filters: [SHOWTRAK_FILE_FILTER],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
  },
};
