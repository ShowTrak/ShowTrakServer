async function Init() {
  const Config = await window.API.GetConfig();
  if (Config && Config.Application && Config.Application.Version && Config.Application.Name) {
    document.getElementById('FOOTER').innerText =
      `${Config.Application.Name} v${Config.Application.Version}`;
  } else {
    document.getElementById('FOOTER').innerText = 'ShowTrak Server';
  }
}
Init();
