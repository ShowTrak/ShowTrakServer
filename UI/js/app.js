var Config = {}

let Selected = [];
let AllClients = [];
let ScriptList = [];
const GroupUUIDCache = new Map();

window.API.ShutdownRequested(async () => {
    let Confirmation = await ConfirmationDialog('Are you sure you want to shutdown ShowTrak?');
    if (!Confirmation) return;
    await window.API.Shutdown();
})

window.API.UpdateScriptExecutions(async (Executions) => {
    Executions = Executions.reverse();

    let Filler = "";
    for (const Request of Executions) {

        let Badge = `<span class="badge bg-secondary text-light">
            ${Request.Status}
        </span>`
        if (Request.Status == 'Completed') {
            Badge = `<span class="badge bg-secondary text-light">
                ${Request.Timer.Duration}ms
            </span>
            <span class="badge bg-success text-light">
                ${Request.Status}
            </span>`
        }
        if (Request.Status == 'Failed') {
            Badge = `<span class="badge bg-ghost-light text-light">
                ${Request.Timer.Duration}ms
            </span>
            <span class="badge bg-danger text-light">
                ${Request.Status}
            </span>`
        }
        if (Request.Status == 'Timed Out') {
            Badge = `<span class="badge bg-danger text-light">
                ${Request.Status}
            </span>`

            if (!Request.Internal) {
                Badge = `<span class="badge bg-ghost-light text-light cursor-pointer" onclick="window.API.ExecuteScript('${Request.Script.ID}', ['${Request.Client.UUID}'], false)">
                    Retry
                </span>` + Badge;
            }
        }

        Filler += `<div class="d-flex justify-content-between p-2 rounded bg-ghost">
            <div class="d-flex justify-content-start gap-2">
            <span class="badge bg-ghost-light text-light">
                ${Request.Client.Nickname || Request.Client.Hostname}
            </span>
            <span class="badge bg-ghost-light text-light">
                ${Request.Script.Name}
            </span>
            </div>
            <div class="d-flex justify-content-start gap-2">
                ${Badge}    
            </div>
        </div>`;
    }

    $('#SHOWTRAK_EXECUTIONQUEUE').html(Filler);
    return;
})

window.API.SetScriptList(async (Scripts) => {
    ScriptList = Scripts;
    return;
})

window.API.SetFullClientList(async (Clients, Groups) => {
    AllClients = Clients.map(Client => Client.UUID);
    let Filler = "";

    Groups.push({
        GroupID: null,
        Title: 'No Group',
        Weight: 100000,
    })

    // Sort groups by weight
    Groups = Groups.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));

    for (const { GroupID, Title } of Groups) {

        let GroupClients = Clients.filter(Client => Client.GroupID === GroupID);

        GroupUUIDCache.set(`${GroupID}`, GroupClients.map(c => c.UUID));

        if (GroupClients.length == 0 && GroupID == null) continue; 

        Filler += `<div class="d-flex justify-content-start">
        <div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded" onclick="SelectByGroup('${GroupID}')">
            <div class="d-flex align-items-center text-center h-100">
                <span class="GROUP_TITLE py-2">
                    ${Title}
                </span>
            </div>
        </div>
        <div class="bg-ghost rounded m-3 mb-0 d-flex flex-wrap justify-content-start align-items-center p-3 gap-3 w-100">`

        if (GroupClients.length == 0) {
            Filler += `<div class="SHOWTRAK_PC_PLACEHOLDER w-100 p-3"
                <h5 class="text-muted mb-0">
                    Empty Group
                </h5>
                <p class="text-muted mb-0">
                    This group has no clients assigned to it.
                </p>
                <p class="text-muted mb-0">
                    You can add clients to this group via the client editor!
                </p>
            </div>`
        } else {
            for (const { Nickname, Hostname, IP, UUID, Version, Online, LastSeen } of GroupClients) {
                Filler += `<div ID="CLIENT_TILE_${UUID}" class="SHOWTRAK_PC ${Online ? 'ONLINE' : ''} ${Selected.includes(UUID) ? 'SELECTED' : ''}" data-uuid="${UUID}">
                    <label class="text-sm" data-type="Hostname">
                        ${Nickname ? Hostname : 'v'+Version}
                    </label>
                    <h5 class="mb-0" data-type="Nickname">
                    ${Nickname ? Nickname : Hostname}
                    </h5>
                    <small class="text-sm text-light" data-type="IP">
                        ${IP ? IP : 'Unknown IP'}
                    </small>
                    <div class="SHOWTRAK_PC_STATUS ${Online ? 'd-grid' : 'd-none'} gap-2" data-type="INDICATOR_ONLINE">
                        <div class="progress"><div data-type="CPU" class="progress-bar bg-white" role="progressbar" style="width: 0%;"></div></div>
                        <div class="progress">
                        <div data-type="RAM" class="progress-bar bg-white" role="progressbar" style="width: 0%;"></div>
                    </div>
                    </div>
                    <div class="SHOWTRAK_PC_STATUS ${Online ? 'd-none' : 'd-grid'}" data-type="INDICATOR_OFFLINE">
                        <h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${LastSeen}">
                            OFFLINE <span class="badge bg-ghost">00:00:00</span>
                        </h7>
                    </div>
                </div>`
            }
        }

        Filler += `</div></div>`
    }    

    Filler += `<div class="d-flex justify-content-start">
        <div class="GROUP_TITLE_CLICKABLE m-3 me-0 rounded" onclick="OpenGroupCreationModal()">
            <div class="d-flex align-items-center text-center h-100">
                <span class="GROUP_CREATE_BUTTON py-2">+</span>
            </div>
        </div>
    </div>`

    $('#APPLICATION_CONTENT').html(Filler);

})

window.API.ClientUpdated(async (Data) => {
    const { UUID, Nickname, Hostname, Version, IP, Online, Vitals } = Data;
    $(`[data-uuid='${UUID}']`).toggleClass('ONLINE', Online);

    let ComputedHostname = Nickname ? Hostname : 'v'+Version;
    if ($(`[data-uuid='${UUID}']>[data-type="Hostname"]`).text() !== ComputedHostname) {
        $(`[data-uuid='${UUID}']>[data-type="Hostname"]`).text(ComputedHostname);
    }

    let ComputedNickname = Nickname ? Nickname : Hostname;
    if ($(`[data-uuid='${UUID}']>[data-type="Nickname"]`).text() !== ComputedNickname) {
        $(`[data-uuid='${UUID}']>[data-type="Nickname"]`).text(ComputedNickname);
    }

    let ComputedIP = IP ? IP : 'Unknown IP';
    if ($(`[data-uuid='${UUID}']>[data-type="IP"]`).text() !== ComputedIP) {
        $(`[data-uuid='${UUID}']>[data-type="IP"]`).text(ComputedIP);
    }

    if (Online) {
        $(`[data-uuid='${UUID}']>div>.progress>[data-type="CPU"]`).css('width', `${Vitals.CPU.UsagePercentage}%`);
        $(`[data-uuid='${UUID}']>div>.progress>[data-type="RAM"]`).css('width', `${Vitals.Ram.UsagePercentage}%`);
        $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).addClass('d-none');
        $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).removeClass('d-grid');
        $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).addClass('d-grid');
        $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).removeClass('d-none');
    } else {
        $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).addClass('d-grid');
        $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).removeClass('d-none');
        $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).addClass('d-none');
        $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).removeClass('d-grid');
    }

    $(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]`).attr('data-offlinesince', Data.LastSeen);
    return;
})

window.API.SetDevicesPendingAdoption(async (Data) => {

    let Filler = "";
    for (const { Hostname, IP, UUID, Version, State } of Data) {
        let ButtonState = ` <div class="d-flex flex-column justify-content-center gap-0">
                <a class="btn btn-light btn-sm" onclick="AdoptDevice('${UUID}')">Adopt</a>
            </div>`
        if (Version != Config.Application.Version) {
            ButtonState = ` <div class="d-flex flex-column justify-content-center gap-0">
                <a class="btn btn-danger btn-sm disabled" disabled>Incompatible Version (v${Version})</a>
            </div>`;
        }
        if (State === 'Adopting') {
            ButtonState = `<div class="d-flex flex-column justify-content-center gap-0">
                <button class="btn btn-secondary btn-sm" disabled>
                <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                    Adopting...
                </button>
            </div>`;
        }

        Filler += `<div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 d-flex justify-content-between p-3" data-uuid="${UUID}">
            <div class="d-flex flex-column justify-content-center gap-1 text-start">
                <h6 class="card-title mb-0">${Hostname}</h6>
                <small class="text-muted">${IP}</small>
                <small class="text-muted">${UUID} - v${Version}</small>
            </div>
            ${ButtonState}
        </div>`;
    }
    if (Data.length === 0) {
        Filler = `<div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 text-center text-muted p-3">No devices pending adoption</div>`;
    }
    $('#DEVICES_PENDING_ADOPTION').html(Filler);

});

async function ExecuteScript(Script, Targets) {
    let ScriptTarget = ScriptList.find(s => s.ID === Script);
    if (!ScriptTarget) {
        console.error('Script not found:', Script);
        return;
    }
    console.log(`Executing script ${ScriptTarget.Name} on targets:`, Targets);

    await window.API.ExecuteScript(Script, Targets, true);
    $('#SHOWTRAK_MODEL_EXECUTIONQUEUE').modal('show');
}

async function CloseAllModals() {
    $('.modal').modal('hide');
    await Wait(300);
    return;
}

async function OpenGroupCreationModal() {
    await CloseAllModals();

    let Groups = await window.API.GetAllGroups();
    if (!Groups) Groups = [];

    $('#SHOWTRAL_MODAL_GROUPCREATION').modal('show');

    $('#GROUP_CREATION_SUBMIT').off('click').on('click', async () => {
        let GroupName = $('#GROUP_CREATION_TITLE').val();
        if (!GroupName) return Notify('Please enter a group name', 'error');

        await window.API.CreateGroup(GroupName);
        OpenGroupManager();
        $('#SHOWTRAL_MODAL_GROUPCREATION').modal('hide');
    });
}

async function ImportConfig() {
    console.warn('Starting import');
    await window.API.ImportConfig();
    console.warn('Backup Completed');
}

async function BackupConfig() {
    console.warn('Starting backup');
    await window.API.BackupConfig();
    console.warn('Backup Completed');
}

async function DeleteGroup(GroupID) {
    await window.API.DeleteGroup(GroupID);
    await OpenGroupManager(true)
}

async function OpenGroupManager(Relaunching = false) {
    if (!Relaunching) await CloseAllModals();

    let Groups = await window.API.GetAllGroups();

    $('#GROUP_MANAGER_GROUP_LIST').html('');
    console.log(GroupUUIDCache);
    for (const Group of Groups) {
        let GroupMembers = GroupUUIDCache.has(`${Group.GroupID}`) ? GroupUUIDCache.get(`${Group.GroupID}`) : [];
        $('#GROUP_MANAGER_GROUP_LIST').append(`
            <div class="GROUP_MANAGER_GROUP_ITEM d-flex justify-content-between align-items-center p-3 rounded bg-ghost" data-groupid="${Group.GroupID}">
                <span class="GROUP_MANAGER_GROUP_TITLE text-bold">
                    ${Group.Title} 
                </span>
                <div class="d-flex gap-2">
                    <span class="badge bg-ghost-light text-light">
                        ${GroupMembers.length} ${GroupMembers.length == 1 ? 'Client' : 'Clients'}
                    </span>
                    <a class="badge bg-danger text-light cursor-pointer text-decoration-none GROUP_MANAGER_GROUP_DELETE" onclick="DeleteGroup(${Group.GroupID})">
                        Delete
                    </a>
                </div>
            </div>
        `);
    }

    let GroupMembers = GroupUUIDCache.has(`null`) ? GroupUUIDCache.get(`null`) : [];
    $('#GROUP_MANAGER_GROUP_LIST').append(`
        <div class="GROUP_MANAGER_GROUP_ITEM d-flex justify-content-between align-items-center p-3 rounded bg-ghost">
            <span class="GROUP_MANAGER_GROUP_TITLE">
                Default Group
            </span>
            <span class="badge bg-ghost-light text-light">
                ${GroupMembers.length} ${GroupMembers.length == 1 ? 'Client' : 'Clients'}
            </span>
        </div>
    `);

    $('#GROUP_MANAGER_GROUP_LIST').append(`
        <div class="d-grid gap-2">
            <button class="btn btn-sm btn-success" onclick="OpenGroupCreationModal()">New Group</button>
        </div>
    `);

    $('#SHOWTRAK_MODAL_GROUPMANAGER').modal('show');
}

async function OpenClientEditor(UUID) {
    let Client = await window.API.GetClient(UUID);
    if (!Client) return console.error('Client not found:', UUID);

    let Groups = await window.API.GetAllGroups();
    if (!Groups) Groups = [];
    Groups.push({
        GroupID: null,
        Title: 'No Group',
        Weight: 100000,
    })

    $('#CLIENT_EDITOR_GROUPID').html('');
    for (const Group of Groups) {
        $('#CLIENT_EDITOR_GROUPID').append(`<option value="${Group.GroupID}" ${Client.GroupID == Group.GroupID ? 'selected' : ''}>${Group.Title}</option>`);
    }


    ClearSelection();
    console.log(Client);

    const { Nickname, Hostname, IP, Version } = Client;

    $('#CLIENT_EDITOR_NICKNAME').val(Nickname ? Nickname : Hostname)
    $('#CLIENT_EDITOR_HOSTNAME').val(Hostname)
    $('#CLIENT_EDITOR_IP').val(IP)
    $('#CLIENT_EDITOR_UUID').val(UUID)
    $('#CLIENT_EDITOR_VERSION').val(Version)

    $('#SHOWTRAK_CLIENT_EDITOR_REMOVE').off('click').on('click', async () => {
        await window.API.UnadoptClient(UUID)
        await CloseAllModals();
    })

    $('#SHOWTRAK_CLIENT_EDITOR_SAVE').off('click').on('click', async () => {
        let Nickname = $('#CLIENT_EDITOR_NICKNAME').val();
        if (!Nickname) Nickname = Hostname;

        let GroupID = $('#CLIENT_EDITOR_GROUPID').val();
        if (GroupID == null || GroupID == 'null') {
            GroupID = null;
        } else {
            GroupID = parseInt(GroupID);
        }


        await window.API.UpdateClient(UUID, {
            Nickname: Nickname,
            GroupID: GroupID,
        })
        await CloseAllModals();
    })

    $('#SHOWTRAK_CLIENT_EDITOR').modal('show');
}

async function AdoptDevice(UUID) {
    await window.API.AdoptDevice(UUID);
}

function SelectByGroup(GroupID) {
    if (!GroupUUIDCache.has(`${GroupID}`)) return;
    let UUIDs = GroupUUIDCache.get(`${GroupID}`);

    // If all uuids are already selected, deselect them
    if (UUIDs.every(UUID => IsSelected(UUID))) {
        UUIDs.forEach(UUID => Deselect(UUID));
        return;
    } else {
        UUIDs.forEach(UUID => Select(UUID));
    }


}

async function Main() {
    console.log(Config);
}

async function Wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function Notify(Message, Type = 'info') {
    console.log('Notify:', Message, Type);
}

async function ConfirmationDialog(Message) {
    return new Promise((resolve, reject) => {
        console.log('Opening confirmation dialog:', Message);

        $('#SHOWTRAK_CONFIRMATION_MESSAGE').text(Message);

        $('#SHOWTRAK_CONFIRMATION_CANCEL').off('click').on('click', () => {
            $('#SHOWTRAL_MODAL_CONFIRMATION').modal('hide');
            resolve(false);
        });
        $('#SHOWTRAK_CONFIRMATION_CONFIRM').off('click').on('click', () => {
            $('#SHOWTRAL_MODAL_CONFIRMATION').modal('hide');
            resolve(true);
        });

        $('#SHOWTRAL_MODAL_CONFIRMATION').modal({
            backdrop: 'static',
            keyboard: false
        });
        $('#SHOWTRAL_MODAL_CONFIRMATION').modal('show');
    });
}

function UpdateSelectionCount() {
    $('#STATUS_BAR').text(`${Selected.length} ${Selected.length == 1 ? 'Client' : 'Clients'} Selected`);
    $('#STATUS_BAR').toggleClass('STATUS_BAR_ACTIVE', Selected.length > 0);
}

function IsSelected(UUID) {
    return Selected.includes(UUID);
}

function Select(UUID) {
    if (Selected.includes(UUID)) return;
    Selected.push(UUID);
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
    UpdateSelectionCount();
    return;
}

function Deselect(UUID) {
    Selected = Selected.filter(id => id !== UUID);
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
    UpdateSelectionCount();
    return;
}

function ClearSelection() {
    Selected.forEach(uuid => {
        $(`.SHOWTRAK_PC[data-uuid='${uuid}']`).removeClass('SELECTED');
    });
    Selected = [];
    UpdateSelectionCount();
    return;
}

function ToggleSelection(UUID) {
    if (Selected.includes(UUID)) {
        Selected = Selected.filter(id => id !== UUID);
        $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
    } else {
        Selected.push(UUID);
        $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
    }
    UpdateSelectionCount();
}

async function UpdateOfflineIndicators() {
    let CurrentTime = new Date().getTime();
    $('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]').each(function() {
        let LastSeen = $(this).attr('data-offlinesince');
        if (!LastSeen) return;
        LastSeen = parseInt(LastSeen);
        let OfflineDuration = CurrentTime - LastSeen;
        let Hours = Math.floor(OfflineDuration / (1000 * 60 * 60));
        let Minutes = Math.floor((OfflineDuration % (1000 * 60 * 60)) / (1000 * 60));
        let Seconds = Math.floor((OfflineDuration % (1000 * 60)) / 1000);
        let HH = String(Hours).padStart(2, '0');
        let MM = String(Minutes).padStart(2, '0');
        let SS = String(Seconds).padStart(2, '0');
        $(this).html(`OFFLINE <span class="badge bg-ghost">${HH}:${MM}:${SS}</span>`);
    });
}

$(function() {
    const $menu = $('#SHOWTRAK_CONTEXT_MENU');
    $(document).on('click', '.SHOWTRAK_PC', function(e) {
        e.preventDefault();
        let UUID = $(this).attr('data-uuid');
        ToggleSelection(UUID);
        return;
    });
    $(document).on('contextmenu', 'html', function(e) {
        e.preventDefault()
        let Options = [];

        if (Selected.length == 1) {
            Options.push({
                Type: 'Action',
                Title: 'View Client',
                Class: 'text-light',
                Action: function() {
                    let Target = Selected[0];
                    OpenClientEditor(Target);
                }
            });
            Options.push({
                Type: 'Divider'
            });
        }

        if (Selected.length == 0) {
            Options.push({
                Type: 'Info',
                Title: 'No Selected Clients',
                Class: 'text-muted',
            });
        }

        if (Selected.length > 0) {
            ScriptList = ScriptList.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));
            for (const Script of ScriptList) {
                Options.push({
                    Type: 'Action',
                    Title: `Run "${Script.Name}"`,
                    Class: `text-${Script.LabelStyle}`,
                    Action: async function() {
                        if (Script.Confirmation) {
                            let Confirmation = await ConfirmationDialog(`Are you sure you want to run "${Script.Name}" on ${Selected.length} ${Selected.length == 1 ? 'Client' : 'Clients'}?`);
                            if (!Confirmation) return;
                        }
                        await ExecuteScript(Script.ID, Selected, true);
                    }
                });
            }
        }

        if (Options.length > 0) {
            Options.push({
                Type: 'Divider'
            });
        }

        if (Selected.length > 0) {
            Options.push({
                Type: 'Action',
                Title: 'Delete Scripts',
                Class: 'text-warning',
                Action: async function() {
                    let Confirmation = await ConfirmationDialog('Are you sure you want to delete scripts from this pc?');
                    if (!Confirmation) return;
                    window.API.DeleteScripts(Selected);
                    $('#SHOWTRAK_MODEL_EXECUTIONQUEUE').modal('show');
                }
            });
            Options.push({
                Type: 'Action',
                Title: 'Update Scripts',
                Class: 'text-warning',
                Action: async function() {
                    let Confirmation = await ConfirmationDialog('Are you sure you want to update scripts on this pc?');
                    if (!Confirmation) return;
                    window.API.UpdateScripts(Selected);
                    $('#SHOWTRAK_MODEL_EXECUTIONQUEUE').modal('show');
                }
            });
            Options.push({
                Type: 'Action',
                Title: 'Clear Selection',
                Class: 'text-danger',
                Action: async function() {
                    ClearSelection();
                }
            });
        }

        Options.push({
            Type: 'Action',
            Title: 'Select All',
            Class: 'text-light',
            Action: async function() {
                AllClients.map(UUID => Select(UUID));
            }
        });


        $menu.html('');

        Options.forEach(option => {
            if (option.Type === 'Divider') {
                $menu.append(`<hr class="my-2">`);
            }
            if (option.Type === 'Info') {
                $menu.append(`<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${option.Class}">${option.Title}</a>`);
            }
            if (option.Type === 'Action') {
                $menu.append(`<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${option.Class}">${option.Title}</a>`);
                $menu.find('a:last').on('click', function() {
                    option.Action();
                });
            }
        });

        // Calculate menu position to prevent overflow
        const menuWidth = $menu.outerWidth();
        const menuHeight = $menu.outerHeight();
        const pageWidth = $(window).width();
        const pageHeight = $(window).height();
        let left = e.pageX;
        let top = e.pageY;

        // If menu would overflow right, show to the left
        if (left + menuWidth > pageWidth) {
            left = Math.max(0, left - menuWidth);
        }
        // If menu would overflow bottom, show above
        if (top + menuHeight > pageHeight) {
            top = Math.max(0, top - menuHeight);
        }

        $menu.css({
            display: 'block',
            left: left,
            top: top
        });

        $menu.data('target', this);
        return;
    });
    $(document).on('click', function() {
        $menu.hide();
        return;
    });
    $menu.on('click', 'a', function(e) {
        e.stopPropagation();
        $menu.hide();
        return;
    });
});

setInterval(UpdateOfflineIndicators, 1000)

async function Init() {
    Config = await window.API.GetConfig()
    $('#APPLICATION_NAVBAR_TITLE').text(`${Config.Application.Name}`);
    $('#APPLICATION_NAVBAR_STATUS').text(`v${Config.Application.Version}`);

    $('#NAVBAR_CORE_BUTTON').on('click', async () => {
        $('#SHOWTRAK_MODEL_CORE').modal('show');
    })

    $('#SHOWTRAK_MODEL_CORE_ADOPT_BUTTON').on('click', async () => {
        await CloseAllModals();
        $('#SHOWTRAK_MODEL_ADOPTION').modal('show');
    })

    $('#SHOWTRAK_MODEL_CORE_GROUP_MANAGER_BUTTON').on('click', async () => {
        await OpenGroupManager();
    })

    $('#SHOWTRAK_MODEL_CORE_LOGSFOLDER').on('click', async () => {
        await window.API.OpenLogsFolder();
    })

    $('#SHOWTRAK_MODEL_CORE_SCRIPTSFOLDER').on('click', async () => {
        await window.API.OpenScriptsFolder();
    })

    $('#SHOWTRAK_MODEL_CORE_BACKUPCONFIG').on('click', async () => {
        await BackupConfig();
    })

    $('#SHOWTRAK_MODEL_CORE_IMPORTCONFIG').on('click', async () => {
        await ImportConfig();
    })

    $('#SHOWTRAK_MODEL_CORE_SHUTDOWN_BUTTON').on('click', async () => {
        window.API.Shutdown();
    })
    
    await Main();
    await window.API.Loaded();
}

Init();