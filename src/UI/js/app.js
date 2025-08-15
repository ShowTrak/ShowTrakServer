var Config = {};

let Selected = [];
let AllClients = [];
let ScriptList = [];
const GroupUUIDCache = new Map();


let SettingsGroups = [];
let Settings = [];
let SettingDebounceTimers = new Map();

// --- Application Mode (SHOW | EDIT) ---
let AppMode = "SHOW"; // default visual state until backend confirms
function RenderMode(mode) {
	AppMode = (String(mode).toUpperCase() === "EDIT") ? "EDIT" : "SHOW";
	// Highlight the active button
	const btnShow = document.getElementById("MODE_BTN_SHOW");
	const btnEdit = document.getElementById("MODE_BTN_EDIT");
	if (btnShow && btnEdit) {
		const activeClasses = ["btn-light", "text-dark"];
		const inactiveClasses = ["btn-outline-light", "text-light"];

		// reset
		btnShow.classList.remove(...activeClasses, ...inactiveClasses);
		btnEdit.classList.remove(...activeClasses, ...inactiveClasses);

		if (AppMode === "SHOW") {
			btnShow.classList.add(...activeClasses);
			btnEdit.classList.add(...inactiveClasses);
		} else {
			btnEdit.classList.add(...activeClasses);
			btnShow.classList.add(...inactiveClasses);
		}
	}
	document.body.classList.toggle("mode-edit", AppMode === "EDIT");
}

// Subscribe to backend push updates
window.API.OnModeUpdated((mode) => {
	RenderMode(mode);
	// Re-evaluate drag state when mode changes
	if (typeof initializeEditInteractions === 'function') {
		try { initializeEditInteractions(); } catch {}
	}
});

// Wire the toggle to backend
document.addEventListener('DOMContentLoaded', async () => {
	// Wire new button group
	const btnShow = document.getElementById('MODE_BTN_SHOW');
	const btnEdit = document.getElementById('MODE_BTN_EDIT');
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
	// Initialize with backend mode
	try {
		const mode = await window.API.GetMode();
		RenderMode(mode);
	} catch {}
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
}



window.API.PlaySound(async (SoundName) => {
	let sound = Sounds[SoundName] || Sounds.Notification;
	sound.play();
})

window.API.UpdateSettings(async (NewSettings, NewSettingsGroups) => {
	Settings = NewSettings;
	SettingsGroups = NewSettingsGroups;

	$('#SETTINGS').html("");

	for (const Group of SettingsGroups) {
		$(`#SETTINGS`).append(`<div class="bg-ghost-light p-2 rounded">
			<strong class="text-start">
				${Group.Title}
			</strong>
		</div>`);
		let GroupSettings = Settings.filter((s) => s.Group == Group.Name);
		for (const Setting of GroupSettings) {
			if (Setting.Type === "BOOLEAN") {
				$(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-flex justify-content-between text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<div class="form-check form-switch">
						<input class="form-check-input" style="margin-top: 0.6em !important;" type="checkbox" id="SETTING_${Setting.Key}" ${Setting.Value ? "checked" : ""}>
					</div>
				</div>`);
				$(`#SETTING_${Setting.Key}`).off("change").on("change", async function () {
					let NewValue = $(this).is(":checked");
					if (NewValue === Setting.Value) return;
					let Set = Settings.find((s) => s.Key === Setting.Key);
					Set.Value = NewValue;
					Setting.Value = NewValue;
					await window.API.SetSetting(Setting.Key, NewValue);
					Notify(`[${Setting.Title}] ${NewValue ? 'Enabled' : 'Disabled'}`, NewValue ? 'success' : 'error');
				})
			}
			else if (Setting.Type === "STRING") {
				$(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<input type="text" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${Setting.Key}" value="${Safe(Setting.Value)}" placeholder="Enter text..." />
				</div>`);
				$(`#SETTING_${Setting.Key}`).off("input").on("input", function () {
					let el = $(this);
					let NewValue = el.val();
					if (SettingDebounceTimers.has(Setting.Key)) clearTimeout(SettingDebounceTimers.get(Setting.Key));
					SettingDebounceTimers.set(Setting.Key, setTimeout(async () => {
						if (NewValue === Setting.Value) return;
						let Set = Settings.find((s) => s.Key === Setting.Key);
						Set.Value = NewValue;
						Setting.Value = NewValue;
						await window.API.SetSetting(Setting.Key, NewValue);
						Notify(`[${Setting.Title}] Saved`, 'success', 1200);
					}, 600));
				});
			}
			else if (Setting.Type === "INTEGER") {
				$(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<input type="number" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${Setting.Key}" value="${Safe(Setting.Value)}" step="1" />
				</div>`);
				$(`#SETTING_${Setting.Key}`).off("input").on("input", function () {
					let el = $(this);
					let Raw = el.val();
					if (SettingDebounceTimers.has(Setting.Key)) clearTimeout(SettingDebounceTimers.get(Setting.Key));
					SettingDebounceTimers.set(Setting.Key, setTimeout(async () => {
						let NewValue = parseInt(Raw, 10);
						if (isNaN(NewValue)) NewValue = Setting.Value; // keep previous until valid
						if (NewValue === Setting.Value) return;
						let Set = Settings.find((s) => s.Key === Setting.Key);
						Set.Value = NewValue;
						Setting.Value = NewValue;
						await window.API.SetSetting(Setting.Key, NewValue);
						Notify(`[${Setting.Title}] Saved (${NewValue})`, 'success', 1200);
					}, 600));
				});
			}
			else if (Setting.Type === "OPTION") {
				let optionsHtml = '';
				if (Array.isArray(Setting.Options)) {
					for (const opt of Setting.Options) {
						optionsHtml += `<option value="${Safe(opt)}" ${Setting.Value === opt ? 'selected' : ''}>${Safe(opt)}</option>`;
					}
				}
				$(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<select class="form-select form-select-sm bg-ghost-light text-light border-0" id="SETTING_${Setting.Key}">${optionsHtml}</select>
				</div>`);
				$(`#SETTING_${Setting.Key}`).off("change").on("change", async function () {
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

	return;
	
})

function Safe(Input) {
	if (typeof Input === "string") {
		return Input.replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}
	if (typeof Input === "number") {
		return Input.toString();
	}
	if (Array.isArray(Input)) {
		return Input.map(Safe);
	}
	return Input;
}

document.addEventListener("keydown", function (e) {
	if (e.key === "Escape") {
		e.preventDefault();
		return ClearSelection();
	}
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
		e.preventDefault();
		return AllClients.map((UUID) => Select(UUID));
	}
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
		e.preventDefault();
		return ClearSelection();
	}
});

window.API.ShutdownRequested(async () => {
	await CloseAllModals();
	let Confirmation = await ConfirmationDialog("Are you sure you want to shutdown ShowTrak?");
	if (!Confirmation) return;
	await window.API.Shutdown();
});

window.API.USBDeviceAdded(async (Client, Device) => {
	console.log(`USB Device Added: ${Device.ManufacturerName} ${Device.ProductName} to Client ${Client.Nickname}`);
});
window.API.USBDeviceRemoved(async (Client, Device) => {
	console.log(`USB Device Removed: ${Device.ManufacturerName} ${Device.ProductName} to Client ${Client.Nickname}`);
});

window.API.UpdateScriptExecutions(async (Executions) => {
	Executions = Executions.reverse();

	let Filler = "";
	for (const Request of Executions) {
		let ExtraContent = "";

		let Badge = `<span class="badge bg-secondary text-light">
            ${Safe(Request.Status)}
        </span>`;
		if (Request.Status == "Completed") {
			Badge = `<span class="badge bg-secondary text-light">
                ${Safe(Request.Timer.Duration)}ms
            </span>
            <span class="badge bg-success text-light">
                ${Safe(Request.Status)}
            </span>`;
		}
		if (Request.Status == "Failed") {
			Badge = `<span class="badge bg-ghost-light text-light">
                ${Safe(Request.Timer.Duration)}ms
            </span>
            <span class="badge bg-danger text-light">
                ${Safe(Request.Status)}
            </span>`;
			if (Request.Error) {
				ExtraContent = `<div class="bg-ghost p-2 text-center text-danger rounded">
                    ${Safe(Request.Error)}
                </div>`;
			}
		}
		if (Request.Status == "Timed Out") {
			Badge = `<span class="badge bg-danger text-light">
                ${Safe(Request.Status)}
            </span>`;

			if (!Request.Internal) {
				Badge =
					`<span class="badge bg-ghost-light text-light cursor-pointer" onclick="window.API.ExecuteScript('${Request.Script.ID}', ['${Request.Client.UUID}'], false)">
                    Retry
                </span>` + Badge;
			}
		}

		Filler += `<div class="d-flex justify-content-between p-2 rounded bg-ghost">
            <div class="d-flex justify-content-start gap-2">
            <span class="badge bg-ghost-light text-light">
                ${Request.Client.Nickname ? Safe(Request.Client.Nickname) : Safe(Request.Client.Hostname)}
            </span>
            <span class="badge bg-ghost-light text-light">
                ${Safe(Request.Script.Name)}
            </span>
            </div>
            <div class="d-flex justify-content-start gap-2">
                ${Badge}    
            </div>
        </div>
        ${ExtraContent}`;
	}

	$("#SHOWTRAK_EXECUTIONQUEUE").html(Filler);
	return;
});

window.API.SetScriptList(async (Scripts) => {
	ScriptList = Scripts;
	return;
});

window.API.SetFullClientList(async (Clients, Groups) => {
	AllClients = Clients.map((Client) => Client.UUID);
	let Filler = "";

	Groups.push({
		GroupID: null,
		Title: "No Group",
		Weight: 100000,
	});

	// Sort groups by weight
	Groups = Groups.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));

	if (Groups.length == 1 && Clients.length == 0) {
		Filler += `<div class="bg-ghost rounded m-3 mb-0 d-grid gap-0 gap-3 p-3">
            <h5 class="text-light mb-0">
                Welcome to ShowTrak Server v${Safe(Config.Application.Version)}
            </h5>
            <p class="text-light mb-0">
                You don't have any clients configured yet. Discover clients on your network and adopt them with the Adoption Manager below.
            </p>
            <div>
                <a class="btn btn-sm btn-light" onclick="OpenAdoptionManager()">
                    Open Adoption Manager
                </a>
            </div>
        </div>`;
	}

	for (const { GroupID, Title } of Groups) {
		let GroupClients = Clients
			.filter((Client) => Client.GroupID === GroupID)
			.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));

		GroupUUIDCache.set(
			`${GroupID}`,
			GroupClients.map((c) => c.UUID)
		);

		if (GroupClients.length == 0 && GroupID == null) continue;

	Filler += `<div class="d-flex justify-content-start">
		<div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded" onclick="SelectByGroup('${GroupID}')">
			<div class="d-flex align-items-center text-center h-100">
				<span class="GROUP_TITLE py-2">
					${Safe(Title)}
				</span>
			</div>
		</div>
	<div class="bg-ghost rounded m-3 mb-0 d-flex flex-wrap justify-content-start align-items-center p-3 gap-3 w-100 group-drop-zone" data-groupid="${GroupID}">`;

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
			</div>`;
		} else {
			for (const { Nickname, Hostname, IP, UUID, Version, Online, LastSeen } of GroupClients) {
				Filler += `<div ID="CLIENT_TILE_${UUID}" class="SHOWTRAK_PC ${Online ? "ONLINE" : ""} ${
					Selected.includes(UUID) ? "SELECTED" : ""
				}" data-uuid="${UUID}" draggable="${AppMode === 'EDIT' ? 'true' : 'false'}">
					<button type="button" class="CLIENT_TILE_COG" aria-label="Edit Client" title="Edit Client">
						<i class="bi bi-gear-fill"></i>
					</button>
					<label class="text-sm" data-type="Hostname">
						${Nickname && Nickname.length ? Safe(Hostname) + " - v" + Version : "v" + Version}
					</label>
					<h5 class="mb-0" data-type="Nickname">
					${Nickname && Nickname.length ? Safe(Nickname) : Safe(Hostname)}
					</h5>
					<small class="text-sm text-light" data-type="IP">
						${IP ? Safe(IP) : "Unknown IP"}
					</small>
					<div class="SHOWTRAK_PC_STATUS ${Online ? "d-grid" : "d-none"} gap-2" data-type="INDICATOR_ONLINE">
						<div class="progress">
							<div data-type="CPU" class="progress-bar bg-white" role="progressbar" style="width: 0%;"></div>
						</div>
						<div class="progress">
							<div data-type="RAM" class="progress-bar bg-white" role="progressbar" style="width: 0%;"></div>
						</div>
					</div>
					<div class="SHOWTRAK_PC_STATUS ${Online ? "d-none" : "d-grid"}" data-type="INDICATOR_OFFLINE">
						<h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${LastSeen}">
							OFFLINE <span class="badge bg-ghost">00:00:00</span>
						</h7>
					</div>
				</div>`;
			}
		}

		Filler += `</div></div>`;
	}

	Filler += `<div class="d-flex justify-content-start">
		<div class="GROUP_TITLE_CLICKABLE m-3 me-0 rounded" onclick="OpenGroupCreationModal()">
			<div class="d-flex align-items-center text-center h-100">
				<span class="GROUP_CREATE_BUTTON py-2">+</span>
			</div>
		</div>
	</div>`;
	
	$("#APPLICATION_CONTENT").html(Filler);
	// Initialize or teardown edit-mode interactions after render
	if (typeof initializeEditInteractions === 'function') {
		try { initializeEditInteractions(); } catch {}
	}
});

// Drag & Drop reordering/move (only active in EDIT mode)
let DnDState = { dragUUID: null, sourceGroupId: null, ghostEl: null, currentOverGroup: null, rowIndex: null };

function initializeEditInteractions() {
	const isEdit = AppMode === 'EDIT';
	$(".SHOWTRAK_PC").attr("draggable", isEdit);
	if (!isEdit) { teardownDnD(); return; }
	setupDnD();
}

function teardownDnD() {
	if (DnDState.ghostEl && DnDState.ghostEl.remove) {
		try { DnDState.ghostEl.remove(); } catch {}
	}
	DnDState = { dragUUID: null, sourceGroupId: null, ghostEl: null, currentOverGroup: null, rowIndex: null };
	$(document).off("dragstart.dnd dragend.dnd dragover.dnd dragenter.dnd dragleave.dnd drop.dnd");
}

function setupDnD() {
	// Avoid duplicate bindings
	$(document).off("dragstart.dnd dragend.dnd dragover.dnd dragenter.dnd dragleave.dnd drop.dnd");

	$(document).on("dragstart.dnd", ".SHOWTRAK_PC", function (e) {
		if (AppMode !== 'EDIT') return;
		const uuid = $(this).attr('data-uuid');
		DnDState.dragUUID = uuid;
		const $group = $(this).closest('.group-drop-zone');
		DnDState.sourceGroupId = normalizeGroupId($group.attr('data-groupid'));
		try {
			e.originalEvent.dataTransfer.setData('text/plain', uuid);
			e.originalEvent.dataTransfer.effectAllowed = 'move';
		} catch {}
		$(this).addClass('dragging');
	});

	$(document).on("dragend.dnd", ".SHOWTRAK_PC", function () {
		$(this).removeClass('dragging');
	clearGhost();
		if (DnDState.currentOverGroup) $(DnDState.currentOverGroup).removeClass('dnd-over');
	DnDState.currentOverGroup = null;
	DnDState.rowIndex = null;
		DnDState.dragUUID = null;
	});

	$(document).on("dragover.dnd", ".group-drop-zone", function (e) {
		if (AppMode !== 'EDIT') return;
		e.preventDefault();
	try { if (e.originalEvent && e.originalEvent.dataTransfer) e.originalEvent.dataTransfer.dropEffect = 'move'; } catch {}
		const container = this;
		if (DnDState.currentOverGroup !== container) {
			$(DnDState.currentOverGroup).removeClass('dnd-over');
			$(container).addClass('dnd-over');
			DnDState.currentOverGroup = container;
		}
		const mouseX = e.originalEvent.clientX;
		const mouseY = e.originalEvent.clientY;
	positionGhostMarker(container, mouseX, mouseY);
	});

	$(document).on("dragenter.dnd", ".group-drop-zone", function () {
		if (AppMode !== 'EDIT') return;
		$(this).addClass('dnd-over');
	});
	$(document).on("dragleave.dnd", ".group-drop-zone", function (e) {
		if (AppMode !== 'EDIT') return;
		if (!this.contains(e.relatedTarget)) {
			$(this).removeClass('dnd-over');
			clearGhost();
		}
	});

	$(document).on("drop.dnd", ".group-drop-zone", async function (e) {
		if (AppMode !== 'EDIT') return;
		e.preventDefault();
		const targetGroupId = normalizeGroupId($(this).attr('data-groupid'));
		const dragUUID = DnDState.dragUUID || (e.originalEvent.dataTransfer ? e.originalEvent.dataTransfer.getData('text/plain') : null);
		if (!dragUUID) return;
	const order = computeOrderWithGhost(this, dragUUID);
	clearGhost();
		$(this).removeClass('dnd-over');
		DnDState.currentOverGroup = null;
		try { await window.API.SetGroupOrder(targetGroupId, order); } catch {}
	});
}

function normalizeGroupId(val) {
	if (val === undefined || val === null || String(val) === 'null' || String(val) === '') return null;
	const num = parseInt(val, 10);
	return isNaN(num) ? null : num;
}

function createGhostEl() {
	const el = document.createElement('div');
	el.className = 'dnd-ghost';
	el.setAttribute('aria-hidden', 'true');
	el.style.pointerEvents = 'none';
	return el;
}

function clearGhost() {
	if (DnDState.ghostEl && DnDState.ghostEl.parentNode) {
		DnDState.ghostEl.parentNode.removeChild(DnDState.ghostEl);
	}
	DnDState.ghostEl = null;
}

function positionGhostMarker(container, x, y) {
	const tiles = Array.from(container.querySelectorAll('.SHOWTRAK_PC:not(.dragging)'))
		.filter(el => !el.classList.contains('dnd-ghost'));
	const HYSTERESIS_X = 6; // horizontal jitter buffer within a row
	const ROW_TOL = 14;     // tolerance to group tiles into rows
	const ROW_STICKY = 16;  // vertical stickiness to keep current row
	const EDGE_X = 12;      // edge stickiness at start/end of rows
	const EDGE_Y = 12;      // vertical edge tolerance for group start/end

	if (tiles.length === 0) {
		if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
		DnDState.ghostEl.style.width = '220px';
		DnDState.ghostEl.style.height = '110px';
		container.appendChild(DnDState.ghostEl);
		return;
	}

	// Compute rects and rows (group by top within tolerance)
	const rects = tiles.map(t => ({ el: t, r: t.getBoundingClientRect() }))
		.sort((a,b) => a.r.top - b.r.top || a.r.left - b.r.left);
	const rows = [];
	for (const o of rects) {
		const last = rows[rows.length - 1];
		if (!last || Math.abs(o.r.top - last.top) > ROW_TOL) {
			rows.push({ top: o.r.top, bottom: o.r.bottom, tiles: [o], left: o.r.left, right: o.r.right });
		} else {
			last.tiles.push(o);
			last.top = Math.min(last.top, o.r.top);
			last.bottom = Math.max(last.bottom, o.r.bottom);
			last.left = Math.min(last.left, o.r.left);
			last.right = Math.max(last.right, o.r.right);
		}
	}
	// Useful group edges
	const firstRow = rows[0];
	const lastRow = rows[rows.length - 1];

	// Start-of-group zone: snap before first
	const firstTile = tiles[0];
	const firstRect = rects[0].r;
	if ((x <= firstRow.left + EDGE_X && y <= firstRow.bottom + EDGE_Y) || (y <= firstRect.top - EDGE_Y)) {
		if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
		const ghost = DnDState.ghostEl;
		ghost.style.width = `${firstRect.width}px`;
		ghost.style.height = `${firstRect.height}px`;
		firstTile.parentNode.insertBefore(ghost, firstTile);
		return;
	}

	// End-of-group zone: snap after last
	const lastTile = tiles[tiles.length - 1];
	const lastRect = rects[rects.length - 1].r;
	if ((x >= lastRow.right - EDGE_X && y >= lastRow.top - EDGE_Y) || (y >= lastRow.bottom - 2)) {
		if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
		const ghost = DnDState.ghostEl;
		ghost.style.width = `${lastRect.width}px`;
		ghost.style.height = `${lastRect.height}px`;
		container.appendChild(ghost);
		return;
	}

	// Determine active row with hysteresis
	let rowIdx = -1;
	// Keep previous row if cursor still within its sticky band
	if (DnDState.rowIndex !== null && rows[DnDState.rowIndex]) {
		const prev = rows[DnDState.rowIndex];
		if (y >= prev.top - ROW_STICKY && y <= prev.bottom + ROW_STICKY) {
			rowIdx = DnDState.rowIndex;
		}
	}
	if (rowIdx === -1) {
		// Prefer a row whose band contains the cursor
		for (let i = 0; i < rows.length; i++) {
			const rw = rows[i];
			if (y >= rw.top - ROW_STICKY && y <= rw.bottom + ROW_STICKY) { rowIdx = i; break; }
		}
	}
	if (rowIdx === -1) {
		// Fallback: closest by vertical distance to row center
		let bestD = Infinity;
		for (let i = 0; i < rows.length; i++) {
			const rw = rows[i];
			const cy = (rw.top + rw.bottom) / 2;
			const d = Math.abs(y - cy);
			if (d < bestD) { bestD = d; rowIdx = i; }
		}
	}
	if (rowIdx < 0) rowIdx = 0;
	DnDState.rowIndex = rowIdx;

	// Place within the selected row
	const row = rows[rowIdx];
	// Find nearest tile by x within the row
	let nearest = null;
	let nearestDist = Infinity;
	for (const { el, r } of row.tiles) {
		const cx = r.left + r.width / 2;
		const d = Math.abs(x - cx);
		if (d < nearestDist) { nearestDist = d; nearest = { tile: el, rect: r }; }
	}
	if (!nearest) return;

	// Snap to row ends with edge stickiness
	if (x <= row.left + EDGE_X) {
		if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
		const ghost = DnDState.ghostEl;
		ghost.style.width = `${nearest.rect.width}px`;
		ghost.style.height = `${nearest.rect.height}px`;
		const firstInRow = row.tiles[0].el;
		firstInRow.parentNode.insertBefore(ghost, firstInRow);
		return;
	}
	if (x >= row.right - EDGE_X) {
		if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
		const ghost = DnDState.ghostEl;
		ghost.style.width = `${nearest.rect.width}px`;
		ghost.style.height = `${nearest.rect.height}px`;
		const lastInRow = row.tiles[row.tiles.length - 1].el;
		lastInRow.parentNode.insertBefore(ghost, lastInRow.nextSibling);
		return;
	}

	// General within-row placement with horizontal hysteresis
	const centerX = (nearest.rect.left + nearest.rect.right) / 2;
	const before = x < (centerX - HYSTERESIS_X);
	if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
	const ghost = DnDState.ghostEl;
	ghost.style.width = `${nearest.rect.width}px`;
	ghost.style.height = `${nearest.rect.height}px`;
	if (before) {
		nearest.tile.parentNode.insertBefore(ghost, nearest.tile);
	} else {
		nearest.tile.parentNode.insertBefore(ghost, nearest.tile.nextSibling);
	}
}

function computeOrderWithGhost(container, dragUUID) {
	const children = Array.from(container.children);
	let order = [];
	for (const el of children) {
		if (el.classList && el.classList.contains('dnd-ghost')) { order.push(dragUUID); continue; }
		if (el.classList && el.classList.contains('SHOWTRAK_PC')) {
			const id = el.getAttribute('data-uuid');
			if (id && id !== dragUUID) order.push(id);
		}
	}
	if (!order.includes(dragUUID)) order.push(dragUUID);
	return order;
}

async function OpenOSCDictionary() {
	await CloseAllModals();
	$("#OSC_ROUTE_LIST_MODAL").modal("show");
}

window.API.Notify(async (Message, Type, Duration) => {
	Notify(Message, Type, Duration);
})

window.API.SetOSCList(async (Routes) => {
	$('#OSC_ROUTE_LIST').html("");
	$('#OSC_ROUTE_LIST').append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost-light rounded-3">
			The following OSC routes are accessible on port 3333.
		</div>
	`);
	for (const Route of Routes) {
		let PathFiller = "";
		for (const Segment of Route.Path.split("/").filter((s) => s.length > 0)) {
			PathFiller += `<span class="">/</span>`;
			if (Segment.startsWith(":")) {
				PathFiller += `<span class="text-info">[${Safe(Segment.substring(1))}]</span>`;
			} else {
				PathFiller += `<span>${Safe(Segment)}</span>`;
			}
		}

		$('#OSC_ROUTE_LIST').append(`
			<div class="d-grid gap-2 p-2 rounded bg-ghost rounded-3">
				<code class="bg-ghost rounded p-2">${PathFiller}</code>
				<p class="mb-0">${Safe(Route.Title)}</p>
			</div>
		`);
	}
	return;
})

window.API.ClientUpdated(async (Data) => {
	const { UUID, Nickname, Hostname, Version, IP, Online, Vitals } = Data;
	$(`[data-uuid='${UUID}']`).toggleClass("ONLINE", Online);

	let ComputedHostname = Nickname && Nickname.length ? `${Hostname} - v${Version}` : "v" + Version;
	if ($(`[data-uuid='${UUID}']>[data-type="Hostname"]`).text() !== ComputedHostname) {
		$(`[data-uuid='${UUID}']>[data-type="Hostname"]`).text(ComputedHostname);
	}

	let ComputedNickname = Nickname && Nickname.length ? Nickname : Hostname;
	if ($(`[data-uuid='${UUID}']>[data-type="Nickname"]`).text() !== ComputedNickname) {
		$(`[data-uuid='${UUID}']>[data-type="Nickname"]`).text(ComputedNickname);
	}

	let ComputedIP = IP ? IP : "Unknown IP";
	if ($(`[data-uuid='${UUID}']>[data-type="IP"]`).text() !== ComputedIP) {
		$(`[data-uuid='${UUID}']>[data-type="IP"]`).text(ComputedIP);
	}

	if (Online) {
		$(`[data-uuid='${UUID}']>div>.progress>[data-type="CPU"]`).css("width", `${Vitals.CPU.UsagePercentage}%`);
		$(`[data-uuid='${UUID}']>div>.progress>[data-type="RAM"]`).css("width", `${Vitals.Ram.UsagePercentage}%`);
		$(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).addClass("d-none");
		$(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).removeClass("d-grid");
		$(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).addClass("d-grid");
		$(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).removeClass("d-none");
	} else {
		$(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).addClass("d-grid");
		$(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]`).removeClass("d-none");
		$(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).addClass("d-none");
		$(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]`).removeClass("d-grid");
	}

	$(`[data-uuid='${UUID}']>.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]`).attr(
		"data-offlinesince",
		Data.LastSeen
	);
	return;
});

window.API.SetDevicesPendingAdoption(async (Data) => {
	let Filler = "";
	for (const { Hostname, IP, UUID, Version, State } of Data) {
		let VersionArr = Version.split(".");
		let MyVersionArr = Config.Application.Version.split(".");

		let VersionCompatible = true;
		if (VersionArr[0] !== MyVersionArr[0]) VersionCompatible = false;
		if (VersionArr[1] !== MyVersionArr[1]) VersionCompatible = false;

		let ButtonState = ` <div class="d-flex flex-column justify-content-center gap-0">
                <a class="btn btn-light btn-sm" onclick="AdoptDevice('${UUID}')">Adopt</a>
            </div>`;
		if (!VersionCompatible) {
			ButtonState = ` <div class="d-flex flex-column justify-content-center gap-0">
                <a class="btn btn-danger btn-sm disabled" disabled>Incompatible Version (v${Safe(Version)})</a>
            </div>`;
		}
		if (State === "Adopting") {
			ButtonState = `<div class="d-flex flex-column justify-content-center gap-0">
                <button class="btn btn-secondary btn-sm" disabled>
                <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                    Adopting...
                </button>
            </div>`;
		}

		Filler += `<div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 d-flex justify-content-between p-3" data-uuid="${UUID}">
            <div class="d-flex flex-column justify-content-center gap-1 text-start">
                <h6 class="card-title mb-0">${Safe(Hostname)}</h6>
                <small class="text-muted">${Safe(IP)}</small>
                <small class="text-muted">${Safe(UUID)} - v${Safe(Version)}</small>
            </div>
            ${ButtonState}
        </div>`;
	}
	if (Data.length === 0) {
		Filler = `<div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 text-center text-muted p-3">No devices pending adoption</div>`;
	}
	$("#DEVICES_PENDING_ADOPTION").html(Filler);
});

async function ExecuteScript(Script, Targets) {
	let ScriptTarget = ScriptList.find((s) => s.ID === Script);
	if (!ScriptTarget) return Notify("Script not found", "error");
	await window.API.ExecuteScript(Script, Targets, true);
	$("#SHOWTRAK_MODEL_EXECUTIONQUEUE").modal("show");
}

window.API.OSCBulkAction(async (Type, Targets, Args = null) => {
	if (Type == 'ExecuteScript') return await ExecuteScript(Args, Targets);
	if (Type == 'WOL') {
		window.API.WakeOnLan(Targets);
		$("#SHOWTRAK_MODEL_EXECUTIONQUEUE").modal("show");
		return;
	}
	if (Type == 'InternalScript') {

	}
	if (Type == 'Select') return Targets.map((UUID) => Select(UUID));
	if (Type == 'Deselect') return Targets.map((UUID) => Deselect(UUID));
})

async function CloseAllModals() {
	$(".modal").modal("hide");
	await Wait(300);
	return;
}

async function OpenGroupCreationModal() {
	await CloseAllModals();

	let Groups = await window.API.GetAllGroups();
	if (!Groups) Groups = [];

	$("#SHOWTRAL_MODAL_GROUPCREATION").modal("show");

	$("#GROUP_CREATION_SUBMIT")
		.off("click")
		.on("click", async () => {
			let GroupName = $("#GROUP_CREATION_TITLE").val();
			if (!GroupName) return Notify("Please enter a group name", "error");
			if (GroupName.length < 3) return Notify("Group name must be at least 3 characters long", "error");
			if (Groups.some((g) => g.Title.toLowerCase() === GroupName.toLowerCase())) {
				return Notify("A group with this name already exists", "error");
			}
			if (GroupName.length > 10) return Notify("Group name must be less than 50 characters long", "error");

			// Clear the input field
			$("#GROUP_CREATION_TITLE").val("");

			await window.API.CreateGroup(GroupName);
			OpenGroupManager();
			$("#SHOWTRAL_MODAL_GROUPCREATION").modal("hide");
		});
}

async function ImportConfig() {
	console.log("Starting import");
	await window.API.ImportConfig();
	await Notify("Restored from backup.", "success");
}

async function BackupConfig() {
	console.log("Starting backup");
	await window.API.BackupConfig();
	await Notify("Backup completed.", "success");
}

async function DeleteGroup(GroupID) {
	await window.API.DeleteGroup(GroupID);
	await OpenGroupManager(true);
	await Notify("Group deleted.", "success");
}

async function OpenGroupManager(Relaunching = false) {
	if (!Relaunching) await CloseAllModals();

	let Groups = await window.API.GetAllGroups();

	$("#GROUP_MANAGER_GROUP_LIST").html("");
	console.log(GroupUUIDCache);
	for (const Group of Groups) {
		let GroupMembers = GroupUUIDCache.has(`${Group.GroupID}`) ? GroupUUIDCache.get(`${Group.GroupID}`) : [];
		$("#GROUP_MANAGER_GROUP_LIST").append(`
            <div class="GROUP_MANAGER_GROUP_ITEM d-flex justify-content-between align-items-center p-3 rounded bg-ghost" data-groupid="${
				Group.GroupID
			}">
                <span class="GROUP_MANAGER_GROUP_TITLE text-bold">
                    ${Safe(Group.Title)} 
                </span>
                <div class="d-flex gap-2">
                    <span class="badge bg-ghost-light text-light">
                        ${GroupMembers.length} ${GroupMembers.length == 1 ? "Client" : "Clients"}
                    </span>
                    <a class="badge bg-danger text-light cursor-pointer text-decoration-none GROUP_MANAGER_GROUP_DELETE" onclick="DeleteGroup(${
						Group.GroupID
					})">
                        Delete
                    </a>
                </div>
            </div>
        `);
	}

	let GroupMembers = GroupUUIDCache.has(`null`) ? GroupUUIDCache.get(`null`) : [];
	$("#GROUP_MANAGER_GROUP_LIST").append(`
        <div class="GROUP_MANAGER_GROUP_ITEM d-flex justify-content-between align-items-center p-3 rounded bg-ghost">
            <span class="GROUP_MANAGER_GROUP_TITLE">
                Default Group
            </span>
            <span class="badge bg-ghost-light text-light">
                ${GroupMembers.length} ${GroupMembers.length == 1 ? "Client" : "Clients"}
            </span>
        </div>
    `);

	$("#GROUP_MANAGER_GROUP_LIST").append(`
        <div class="d-grid gap-2">
            <button class="btn btn-sm btn-success" onclick="OpenGroupCreationModal()">New Group</button>
        </div>
    `);

	$("#SHOWTRAK_MODAL_GROUPMANAGER").modal("show");
}

async function OpenClientEditor(UUID) {
	let Client = await window.API.GetClient(UUID);
	if (!Client) return console.error("Client not found:", UUID);

	let Groups = await window.API.GetAllGroups();
	if (!Groups) Groups = [];
	Groups.push({
		GroupID: null,
		Title: "No Group",
		Weight: 100000,
	});

	$("#CLIENT_EDITOR_GROUPID").html("");
	for (const Group of Groups) {
		$("#CLIENT_EDITOR_GROUPID").append(
			`<option value="${Group.GroupID}" ${Client.GroupID == Group.GroupID ? "selected" : ""}>${Safe(
				Group.Title
			)}</option>`
		);
	}

	ClearSelection();

	const { Nickname, Hostname, IP, Version, MacAddress } = Client;

	$("#CLIENT_EDITOR_NICKNAME").val(Nickname ? Nickname : Hostname);
	$("#CLIENT_EDITOR_HOSTNAME").val(Hostname);
	$("#CLIENT_EDITOR_IP").val(IP);
	if (MacAddress && String(MacAddress).trim().length > 0) {
		$("#CLIENT_EDITOR_MAC").val(MacAddress.toUpperCase());
		$("#CLIENT_EDITOR_MAC_WRAPPER").removeClass("d-none");
	} else {
		$("#CLIENT_EDITOR_MAC").val("");
		$("#CLIENT_EDITOR_MAC_WRAPPER").addClass("d-none");
	}
	$("#CLIENT_EDITOR_UUID").val(UUID);
	$("#CLIENT_EDITOR_VERSION").val(Version);

	$("#SHOWTRAK_CLIENT_EDITOR_USB_DEVICES").html("");
	if (Client.USBDeviceList && Client.USBDeviceList.length > 0) {
		for (const { ManufacturerName, ProductName, ProductID, SerialNumber, VendorID } of Client.USBDeviceList) {
			$("#SHOWTRAK_CLIENT_EDITOR_USB_DEVICES").append(`
                <div class="rounded-3 p-2 bg-ghost">
                    <h6 class="mb-0">${ManufacturerName ? Safe(ManufacturerName) : "Generic"} ${
				ProductName ? Safe(ProductName) : "USB Device"
			}</h6>
                    <small class="text-light">Serial Number: ${
						SerialNumber ? Safe(SerialNumber) : "Unavailable"
					}</small>
                </div>
            `);
		}
	} else {
		$("#SHOWTRAK_CLIENT_EDITOR_USB_DEVICES").html(`
            <div class="rounded-3 p-2 bg-ghost">
                <h6 class="mb-0">No USB Devices Connected</h6>
                <p class="text-sm mb-0">Devices that do not comply with WebUSB 1.3 cannot be displayed.</p>
            </div>
        `);
	}

	$("#SHOWTRAK_CLIENT_EDITOR_UPDATE")
		.off("click")
		.on("click", async () => {
			await CloseAllModals();
			await window.API.CheckForUpdatesOnClient(UUID);
			$("#SHOWTRAK_MODEL_EXECUTIONQUEUE").modal("show");
		});

	$("#SHOWTRAK_CLIENT_EDITOR_REMOVE")
		.off("click")
		.on("click", async () => {
			await CloseAllModals();
			let Confirmation = await ConfirmationDialog(`Are you sure you want to delete ${Nickname || Hostname}?`);
			if (!Confirmation) return;
			await window.API.UnadoptClient(UUID);
			await Notify(`Unadopted ${Nickname ? Nickname : Hostname}`, "success");
		});

	$("#SHOWTRAK_CLIENT_EDITOR_SAVE")
		.off("click")
		.on("click", async () => {
			let Nickname = $("#CLIENT_EDITOR_NICKNAME").val();
			if (!Nickname) Nickname = Hostname;

			let GroupID = $("#CLIENT_EDITOR_GROUPID").val();
			if (GroupID == null || GroupID == "null") {
				GroupID = null;
			} else {
				GroupID = parseInt(GroupID);
			}

			await window.API.UpdateClient(UUID, {
				Nickname: Nickname,
				GroupID: GroupID,
			});
			await CloseAllModals();
		});

	$("#SHOWTRAK_CLIENT_EDITOR").modal("show");
}

async function AdoptDevice(UUID) {
	await window.API.AdoptDevice(UUID);
}

function SelectByGroup(GroupID) {
	if (!GroupUUIDCache.has(`${GroupID}`)) return;
	let UUIDs = GroupUUIDCache.get(`${GroupID}`);

	if (UUIDs.every((UUID) => IsSelected(UUID))) {
		UUIDs.forEach((UUID) => Deselect(UUID));
	} else {
		UUIDs.forEach((UUID) => Select(UUID));
	}
	return;
}

async function Wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function Notify(Message, Type = "info", Duration = 5000) {

	let Styles = {
		info: "linear-gradient(to right, rgb(63 59 104), rgb(56 52 109))",
		success: "linear-gradient(to right, rgb(40 167 69), rgb(30 139 54))",
		warning: "linear-gradient(to right, rgb(255 193 7), rgb(217 130 43))",
		error: "linear-gradient(to right, rgb(220 53 69), rgb(185 28 28))",
	}

	Toastify({
		text: Message,
		duration: Duration,
		close: false,
		gravity: "top", // `top` or `bottom`
		position: "right", // `left`, `center` or `right`
		stopOnFocus: true, // Prevents dismissing of toast on hover
		offset: {
			y: '2rem',
		},
		style: {
			background: Styles[Type] || Styles.info,
		},
	}).showToast();
}

async function ConfirmationDialog(Message) {
	return new Promise((resolve, reject) => {
		$("#SHOWTRAK_CONFIRMATION_MESSAGE").text(Message);

		$("#SHOWTRAK_CONFIRMATION_CANCEL")
			.off("click")
			.on("click", () => {
				$("#SHOWTRAL_MODAL_CONFIRMATION").modal("hide");
				resolve(false);
			});
		$("#SHOWTRAK_CONFIRMATION_CONFIRM")
			.off("click")
			.on("click", () => {
				$("#SHOWTRAL_MODAL_CONFIRMATION").modal("hide");
				resolve(true);
			});

		$("#SHOWTRAL_MODAL_CONFIRMATION").modal({
			backdrop: "static",
			keyboard: false,
		});
		$("#SHOWTRAL_MODAL_CONFIRMATION").modal("show");
	});
}

function UpdateSelectionCount() {
	$("#SELECTION_STATUS").text(`${Selected.length} ${Selected.length == 1 ? "Client" : "Clients"} Selected`);
	return;
}

function IsSelected(UUID) {
	return Selected.includes(UUID);
}

function Select(UUID) {
	if (Selected.includes(UUID)) return;
	Selected.push(UUID);
	$(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass("SELECTED");
	UpdateSelectionCount();
	return;
}

function Deselect(UUID) {
	Selected = Selected.filter((id) => id !== UUID);
	$(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass("SELECTED");
	UpdateSelectionCount();
	return;
}

function ClearSelection() {
	Selected.forEach((uuid) => {
		$(`.SHOWTRAK_PC[data-uuid='${uuid}']`).removeClass("SELECTED");
	});
	Selected = [];
	UpdateSelectionCount();
	return;
}

function ToggleSelection(UUID) {
	if (Selected.includes(UUID)) {
		Selected = Selected.filter((id) => id !== UUID);
		$(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass("SELECTED");
	} else {
		Selected.push(UUID);
		$(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass("SELECTED");
	}
	UpdateSelectionCount();
}

async function UpdateOfflineIndicators() {
	let CurrentTime = new Date().getTime();
	$('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]').each(function () {
		let LastSeen = $(this).attr("data-offlinesince");
		if (!LastSeen) return;
		LastSeen = parseInt(LastSeen);
		let OfflineDuration = CurrentTime - LastSeen;
		let Hours = Math.floor(OfflineDuration / (1000 * 60 * 60));
		let Minutes = Math.floor((OfflineDuration % (1000 * 60 * 60)) / (1000 * 60));
		let Seconds = Math.floor((OfflineDuration % (1000 * 60)) / 1000);
		let HH = String(Hours).padStart(2, "0");
		let MM = String(Minutes).padStart(2, "0");
		let SS = String(Seconds).padStart(2, "0");
		$(this).html(`OFFLINE <span class="badge bg-ghost">${HH}:${MM}:${SS}</span>`);
	});
}

$(async function () {
	const $menu = $("#SHOWTRAK_CONTEXT_MENU");

	// Copy-to-clipboard for readonly editor fields
	$(document).on('click', '.copy-field-btn', async function (e) {
		e.preventDefault();
		e.stopPropagation();
		const targetSel = $(this).attr('data-target');
		const $input = $(targetSel);
		if (!$input || $input.length === 0) return;
		const value = String($input.val() || '').trim();
		if (!value) return;
		try {
			await navigator.clipboard.writeText(value);
			// quick feedback: icon swap
			const $icon = $(this).find('i');
			const prev = $icon.attr('class');
			$icon.attr('class', 'bi bi-clipboard-check');
			setTimeout(() => { $icon.attr('class', prev); }, 900);
		} catch {}
		return false;
	});

	// Open client editor from cog without affecting selection
	$(document).on("click", ".CLIENT_TILE_COG", function (e) {
		e.preventDefault();
		e.stopPropagation();
		const uuid = $(this).closest('.SHOWTRAK_PC').attr('data-uuid');
		if (uuid) {
			OpenClientEditor(uuid);
		}
		return false;
	});
	$(document).on("click", ".SHOWTRAK_PC", function (e) {
		e.preventDefault();
		let UUID = $(this).attr("data-uuid");
		ToggleSelection(UUID);
		return;
	});
	$(document).on("contextmenu", "html", async function (e) {
		e.preventDefault();
		let Options = [];

		if (Selected.length == 0) {
			Options.push({
				Type: "Info",
				Title: "No Selected Clients",
				Class: "text-muted",
			});
		}

		if (Selected.length > 0) {
			ScriptList = ScriptList.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));
			for (const Script of ScriptList) {
				Options.push({
					Type: "Action",
					Title: `${Script.Name}`,
					Class: `text-${Script.LabelStyle}`,
					Action: async function () {
						if (Script.Confirmation) {
							let Confirmation = await ConfirmationDialog(
								`Are you sure you want to run "${Script.Name}" on ${Selected.length} ${
									Selected.length == 1 ? "Client" : "Clients"
								}?`
							);
							if (!Confirmation) return;
						}
						await ExecuteScript(Script.ID, Selected, true);
					},
				});
			}
		}

		if (ScriptList.length > 0) {
			Options.push({
				Type: "Divider",
			});
		}

		if (Selected.length > 0) {
			let SYSTEM_ALLOW_WOL = await GetSettingValue("SYSTEM_ALLOW_WOL");
			if (SYSTEM_ALLOW_WOL) {
				Options.push({
					Type: "Action",
					Title: "Wake On LAN",
					Class: "text-light",
					Action: async function () {
						window.API.WakeOnLan(Selected);
						$("#SHOWTRAK_MODEL_EXECUTIONQUEUE").modal("show");
					},
				});
			}
			let SYSTEM_ALLOW_SCRIPT_EDITS = await GetSettingValue("SYSTEM_ALLOW_SCRIPT_EDITS");
			if (SYSTEM_ALLOW_SCRIPT_EDITS && AppMode === "EDIT") {
				Options.push({
					Type: "Action",
					Title: "Delete Scripts",
					Class: "text-warning",
					Action: async function () {
						let Confirmation = await ConfirmationDialog(
							"Are you sure you want to delete scripts from clients?"
						);
						if (!Confirmation) return;
						window.API.DeleteScripts(Selected);
						$("#SHOWTRAK_MODEL_EXECUTIONQUEUE").modal("show");
					},
				});
				Options.push({
					Type: "Action",
					Title: "Deploy Scripts",
					Class: "text-warning",
					Action: async function () {
						window.API.UpdateScripts(Selected);
						$("#SHOWTRAK_MODEL_EXECUTIONQUEUE").modal("show");
					},
				});
			}
			Options.push({
				Type: "Action",
				Title: "Clear Selection",
				Class: "text-danger",
				Shortcut: "Ctrl+D",
				Action: async function () {
					ClearSelection();
				},
			});
		}

		Options.push({
			Type: "Action",
			Title: "Select All",
			Class: "text-light",
			Shortcut: "Ctrl+A",
			Action: async function () {
				AllClients.map((UUID) => Select(UUID));
			},
		});

		$menu.html("");

		Options.forEach((option) => {
			if (option.Type === "Divider") {
				$menu.append(`<hr class="my-2">`);
			}
			if (option.Type === "Info") {
				$menu.append(
					`<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(option.Class)}">` +
						`<span class="context-title">${Safe(option.Title)}</span>` +
						`<span class="context-shortcut">${Safe(option.Shortcut || "")}</span>` +
					`</a>`
				);
			}
			if (option.Type === "Action") {
				$menu.append(
					`<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(option.Class)}">` +
						`<span class="context-title">${Safe(option.Title)}</span>` +
						`<span class="context-shortcut">${Safe(option.Shortcut || "")}</span>` +
					`</a>`
				);
				$menu.find("a:last").on("click", function () {
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
			display: "block",
			left: left,
			top: top,
		});

		$menu.data("target", this);
		return;
	});
	$(document).on("click", function () {
		$menu.hide();
		return;
	});
	$menu.on("click", "a", function (e) {
		e.stopPropagation();
		$menu.hide();
		return;
	});
});

setInterval(UpdateOfflineIndicators, 1000);

async function OpenAdoptionManager() {
	await CloseAllModals();
	$("#SHOWTRAK_MODEL_ADOPTION").modal("show");
}

async function Init() {
	Config = await window.API.GetConfig();
	$("#APPLICATION_NAVBAR_TITLE").text(`${Config.Application.Name}`);
	$("#APPLICATION_NAVBAR_STATUS").text(`v${Config.Application.Version}`);

	$('#SHOWTRAK_MODEL_CORE_OPEN_SETTINGS').on("click", async () => {
		await CloseAllModals();
		$("#SHOWTRAK_MODAL_SETTINGS").modal("show")
	})

	$("#NAVBAR_CORE_BUTTON").on("click", async () => {
		$("#SHOWTRAK_MODEL_CORE").modal("show");
	});

	$("#SHOWTRAK_MODEL_CORE_OSC_ROUTE_LIST_BUTTON").on("click", async () => {
		await OpenOSCDictionary();
	});

	$("#SHOWTRAK_MODEL_CORE_ADOPT_BUTTON").on("click", async () => {
		await OpenAdoptionManager();
	});

	$("#SHOWTRAK_MODEL_CORE_GROUP_MANAGER_BUTTON").on("click", async () => {
		await OpenGroupManager();
	});

	$("#SHOWTRAK_MODEL_CORE_LOGSFOLDER").on("click", async () => {
		await window.API.OpenLogsFolder();
	});

	$("#SHOWTRAK_MODEL_CORE_SCRIPTSFOLDER").on("click", async () => {
		await window.API.OpenScriptsFolder();
	});

	$("#SHOWTRAK_MODEL_CORE_BACKUPCONFIG").on("click", async () => {
		await BackupConfig();
	});

	$("#SHOWTRAK_MODEL_CORE_IMPORTCONFIG").on("click", async () => {
		await ImportConfig();
	});

	$("#SHOWTRAK_MODEL_CORE_SUPPORTDISCORD").on("click", async () => {
		await window.API.OpenDiscordInviteLinkInBrowser();
	});

	$("#SHOWTRAK_MODEL_CORE_SHUTDOWN_BUTTON").on("click", async () => {
		window.API.Shutdown();
	});

	// Initialize application mode from backend and wire toggle
	try {
		const mode = await window.API.GetMode();
		RenderMode(mode);
	} catch (_) {
		RenderMode("SHOW");
	}
	// legacy toggle binding removed

	await window.API.Loaded();
}

Init();
