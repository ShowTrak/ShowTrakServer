document.addEventListener('DOMContentLoaded', async () => {
  // Wire new button group
  const btnShow = document.getElementById('MODE_BTN_SHOW');
  const btnEdit = document.getElementById('MODE_BTN_EDIT');
  const btnAlertActions = document.getElementById('ALERT_ACTIONS_TOGGLE_BTN');
  const btnCompact = document.getElementById('COMPACT_MODE_BTN');

  SetCompactMode(LoadCompactModePreference(), { persist: false });

  if (btnShow && !btnShow.dataset.bound) {
    btnShow.addEventListener('click', async () => {
      await window.API.SetMode('SHOW');
    });
    btnShow.dataset.bound = '1';
  }
  if (btnEdit && !btnEdit.dataset.bound) {
    btnEdit.addEventListener('click', async () => {
      await window.API.SetMode('EDIT');
    });
    btnEdit.dataset.bound = '1';
  }
  if (btnAlertActions && !btnAlertActions.dataset.bound) {
    btnAlertActions.addEventListener('click', async () => {
      await SetAlertActionsEnabled(!AlertActionsEnabled);
    });
    btnAlertActions.dataset.bound = '1';
  }
  if (btnCompact && !btnCompact.dataset.bound) {
    btnCompact.addEventListener('click', () => {
      SetCompactMode(!CompactMode);
    });
    btnCompact.dataset.bound = '1';
  }
  // Initialize with backend mode
  try {
    const mode = await window.API.GetMode();
    RenderMode(mode);
  } catch {}
  try {
    const isEnabled = await window.API.GetAlertActionsEnabled();
    RenderAlertActionsToggle(isEnabled);
  } catch {
    RenderAlertActionsToggle(true);
  }
});

async function GetSettingValue(Key) {
  if (Settings.length == 0) Settings = await window.API.GetSettings();
  let Setting = Settings.find((s) => s.Key === Key);
  if (!Setting) return null;
  return Setting.Value;
}

let Sounds = {
  Notification: new Howl({
    src: ['audio/alert_1.wav'],
    volume: 0.5,
  }),
  Alert: new Howl({
    src: ['audio/alert_2.wav'],
    volume: 0.5,
  }),
  Warning: new Howl({
    src: ['audio/alert_3.wav'],
    volume: 0.5,
  }),
};

window.API.PlaySound(async (SoundName) => {
  let sound = Sounds[SoundName] || Sounds.Notification;
  sound.play();
});

window.API.UpdateSettings(async (NewSettings, NewSettingsGroups) => {
  Settings = NewSettings;
  SettingsGroups = NewSettingsGroups;

  $('#SETTINGS').html('');
  $('#REMOTE_ACCESS_SECTION').html('');

  for (const Group of SettingsGroups) {
    $(`#SETTINGS`).append(`<div class="bg-ghost-light p-2 rounded">
			<strong class="text-start">
				${Group.Title}
			</strong>
		</div>`);
    let GroupSettings = Settings.filter((s) => s.Group == Group.Name);
    for (const Setting of GroupSettings) {
      if (Setting.Type === 'BOOLEAN') {
        $(`#SETTINGS`)
          .append(`<div class="bg-ghost p-2 rounded d-flex justify-content-between text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<div class="form-check form-switch">
						<input class="form-check-input" style="margin-top: 0.6em !important;" type="checkbox" id="SETTING_${Setting.Key}" ${
              Setting.Value ? 'checked' : ''
            }>
					</div>
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('change')
          .on('change', async function () {
            let NewValue = $(this).is(':checked');
            if (NewValue === Setting.Value) return;
            let Set = Settings.find((s) => s.Key === Setting.Key);
            Set.Value = NewValue;
            Setting.Value = NewValue;
            await window.API.SetSetting(Setting.Key, NewValue);
            Notify(
              `[${Setting.Title}] ${NewValue ? 'Enabled' : 'Disabled'}`,
              NewValue ? 'success' : 'error'
            );
          });
      } else if (Setting.Type === 'STRING') {
        $(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<input type="text" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${
            Setting.Key
          }" value="${Safe(Setting.Value)}" placeholder="Enter text..." />
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('input')
          .on('input', function () {
            let el = $(this);
            let NewValue = el.val();
            if (SettingDebounceTimers.has(Setting.Key))
              clearTimeout(SettingDebounceTimers.get(Setting.Key));
            SettingDebounceTimers.set(
              Setting.Key,
              setTimeout(async () => {
                if (NewValue === Setting.Value) return;
                let Set = Settings.find((s) => s.Key === Setting.Key);
                Set.Value = NewValue;
                Setting.Value = NewValue;
                await window.API.SetSetting(Setting.Key, NewValue);
                Notify(`[${Setting.Title}] Saved`, 'success', 1200);
              }, 600)
            );
          });
      } else if (Setting.Type === 'INTEGER') {
        $(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<input type="number" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${
            Setting.Key
          }" value="${Safe(Setting.Value)}" step="1" />
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('input')
          .on('input', function () {
            let el = $(this);
            let Raw = el.val();
            if (SettingDebounceTimers.has(Setting.Key))
              clearTimeout(SettingDebounceTimers.get(Setting.Key));
            SettingDebounceTimers.set(
              Setting.Key,
              setTimeout(async () => {
                let NewValue = parseInt(Raw, 10);
                if (isNaN(NewValue)) NewValue = Setting.Value; // keep previous until valid
                if (NewValue === Setting.Value) return;
                let Set = Settings.find((s) => s.Key === Setting.Key);
                Set.Value = NewValue;
                Setting.Value = NewValue;
                await window.API.SetSetting(Setting.Key, NewValue);
                Notify(`[${Setting.Title}] Saved (${NewValue})`, 'success', 1200);
              }, 600)
            );
          });
      } else if (Setting.Type === 'OPTION') {
        let optionsHtml = '';
        if (Array.isArray(Setting.Options)) {
          for (const opt of Setting.Options) {
            optionsHtml += `<option value="${Safe(opt)}" ${Setting.Value === opt ? 'selected' : ''}>${Safe(
              opt
            )}</option>`;
          }
        }
        $(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<select class="form-select form-select-sm bg-ghost-light text-light border-0" id="SETTING_${Setting.Key}">${optionsHtml}</select>
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('change')
          .on('change', async function () {
            let NewValue = $(this).val();
            if (NewValue === Setting.Value) return;
            let Set = Settings.find((s) => s.Key === Setting.Key);
            Set.Value = NewValue;
            Setting.Value = NewValue;
            await window.API.SetSetting(Setting.Key, NewValue);
            Notify(`[${Setting.Title}] ${NewValue}`, 'success', 1200);
          });
      }
    }
  }

  // Remote Access section: enumerate Web UI addresses and render list with QR
  try {
    const info = await window.API.GetWebUIAddresses();
    const urls = (info && info.urls) || [];
    if (urls.length) {
      const $container = $('#REMOTE_ACCESS_SECTION');
      $container.append(`
        <div class="bg-ghost-light p-2 rounded text-start">
          <strong>Remote Access</strong>
          <div class="text-sm text-muted">Connect from your phone on the same network.</div>
        </div>
      `);
      const rows = urls
        .map((u, idx) => {
          const safe = Safe(u.url);
          return `
            <div class="bg-ghost p-2 rounded d-flex justify-content-between align-items-center text-start">
              <div class="d-grid">
                <span>${safe}</span>
                <span class="text-sm text-muted">${Safe(u.host)}</span>
              </div>
            </div>`;
        })
        .join('');
      $container.append(rows);
      // Bind QR buttons
      $container.find('[data-qr-url]').off('click').on('click', function () {
        const url = $(this).attr('data-qr-url');
        ShowQRModal(url);
      });
    }
  } catch {}

  return;
});

