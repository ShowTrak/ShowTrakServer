const { Client, Message } = require('node-osc');

const ID = 'osc-trigger';

const Settings = [
  { Key: 'TargetIP', Label: 'Target IP / Hostname', Type: 'string', Default: '127.0.0.1' },
  { Key: 'Port', Label: 'Port', Type: 'number', Default: 3333, Min: 1, Max: 65535 },
  { Key: 'Message', Label: 'OSC Message Path', Type: 'string', Default: '/API/Alert' },
];

function interpolate(Input, Context) {
  const Source = String(Input == null ? '' : Input);
  const Tokens = {
    triggerType: Context && Context.TriggerType ? Context.TriggerType : '',
    entityName: Context && Context.EntityName ? Context.EntityName : '',
    severity: Context && Context.Severity ? Context.Severity : '',
    ip: Context && Context.IP ? Context.IP : '',
    uuid: Context && Context.UUID ? Context.UUID : '',
    groupId: Context && Context.GroupID != null ? String(Context.GroupID) : '',
  };

  return Source.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(Tokens, key) ? Tokens[key] : ''
  );
}

function NormalizeSettings(Input) {
  const Next = Input && typeof Input === 'object' ? Input : {};
  const Port = Number(Next.Port);
  return {
    TargetIP: String(Next.TargetIP || '127.0.0.1').trim(),
    Port: Number.isFinite(Port) ? Math.max(1, Math.min(65535, Math.round(Port))) : 3333,
    Message: String(Next.Message || '/API/Alert').trim() || '/API/Alert',
  };
}

function ValidateSettings(SettingsInput) {
  const S = NormalizeSettings(SettingsInput);
  if (!S.TargetIP) throw new Error('TargetIP is required');
  if (!S.Message.startsWith('/')) throw new Error('Message must start with "/"');
  return true;
}

async function Execute(Action, Context, Logger) {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});
  const MsgPath = interpolate(S.Message, Context);

  return new Promise((resolve) => {
    let ClientRef;
    try {
      ClientRef = new Client(S.TargetIP, S.Port);
      const MessageRef = new Message(MsgPath);
      ClientRef.send(MessageRef, () => {
        try {
          ClientRef.close();
        } catch (_closeErr) {
          void 0;
        }
        Logger.info(`OSC alert sent to ${S.TargetIP}:${S.Port} (${MsgPath})`);
        resolve({ Success: true });
      });
    } catch (Err) {
      try {
        if (ClientRef) ClientRef.close();
      } catch (_closeErr) {
        void 0;
      }
      resolve({
        Success: false,
        Error: Err && Err.message ? Err.message : String(Err),
      });
    }
  });
}

module.exports = {
  ID,
  Name: 'OSC Trigger',
  Description: 'Sends an OSC message route/path to a remote endpoint.',
  Settings,
  NormalizeSettings,
  ValidateSettings,
  Execute,
};
