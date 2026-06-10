const { Manager: BroadcastManager } = require('../Broadcast');

const ID = 'showtrak-alert';

const Settings = [
  {
    Key: 'Title',
    Label: 'Custom Title (optional)',
    Type: 'string',
    Default: '',
  },
];

function NormalizeSettings(Input) {
  const Next = Input && typeof Input === 'object' ? Input : {};
  const Title = String(Next.Title == null ? '' : Next.Title)
    .trim()
    .slice(0, 120);
  return { Title };
}

function ValidateSettings(SettingsInput) {
  NormalizeSettings(SettingsInput);
  return true;
}

async function Execute(Action, Context, Logger) {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});
  const Description = Context && Context.Description ? Context.Description : '';

  const Payload = {
    Title: S.Title || Description || 'ShowTrak Alert',
    Message: S.Title ? Description : '',
    Severity: (Context && Context.Severity) || 'info',
    TriggerType: (Context && Context.TriggerType) || null,
    UUID: (Context && Context.UUID) || null,
  };

  BroadcastManager.emit('CreateShowTrakAlert', Payload);
  Logger.info('ShowTrak alert action queued');
  return { Success: true };
}

module.exports = {
  ID,
  Name: 'Create ShowTrak Alert',
  Description: 'Raises an alert in the ShowTrak alerts tray with an optional custom title.',
  Settings,
  NormalizeSettings,
  ValidateSettings,
  Execute,
};
