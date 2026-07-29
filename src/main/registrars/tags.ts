// IPC registrar: client tags (create/slug/colour/icon/display/scope/order/delete).
// Tags are cross-cutting, colour+icon labelled collections of clients; the slug
// doubles as the label. Membership is a dynamic scope ({ Workspace, Groups[],
// Clients[] }) edited with the shared scope-dropdown.

import { RPC } from '../rpc';
import { createTupleHandler, validationErrorTuple } from '../ipc/create-handler';
import { Manager as TagManager } from '../../Modules/TagManager';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

function register(): void {
  // Reader: full tag list (serialized views). Empty list on any error.
  RPC.handle('Tags:GetAll', async (_Event: unknown) => {
    return TagManager.GetAllViews();
  });

  // Create a tag (optional starting label; a unique slug is derived from it).
  // Returns the created tag view so the renderer can open it in the editor.
  RPC.handle('Tags:Create', async (_Event: unknown, Label: unknown) => {
    const [Err, Tag] = await TagManager.Create(typeof Label === 'string' ? Label : undefined);
    if (Err || !Tag) return [Err || 'Failed to create tag', null];
    return [null, Tag.ToView()];
  });

  RPC.handle(
    'Tags:SetSlug',
    createTupleHandler<[number, string], unknown>(
      (TagID: unknown, Slug: unknown) => [IPCValidation.TagID(TagID), IPCValidation.Slug(Slug)],
      (TagID: number, Slug: string) => TagManager.SetSlug(TagID, Slug)
    )
  );

  RPC.handle(
    'Tags:SetColour',
    createTupleHandler<[number, number], unknown>(
      (TagID: unknown, Colour: unknown) => [
        IPCValidation.TagID(TagID),
        IPCValidation.TagColour(Colour),
      ],
      (TagID: number, Colour: number) => TagManager.SetColour(TagID, Colour)
    )
  );

  RPC.handle(
    'Tags:SetIcon',
    createTupleHandler<[number, string], unknown>(
      // The manager normalizes/validates the icon name (strips "bi-", defaults);
      // here we only enforce it is a string.
      (TagID: unknown, Icon: unknown) => [
        IPCValidation.TagID(TagID),
        typeof Icon === 'string' ? Icon : '',
      ],
      (TagID: number, Icon: string) => TagManager.SetIcon(TagID, Icon)
    )
  );

  // Tile presentation only ('hidden' | 'icon' | 'name' | 'both'); membership and
  // every targeting path are unaffected by it.
  RPC.handle(
    'Tags:SetDisplay',
    createTupleHandler<[number, string], unknown>(
      (TagID: unknown, Display: unknown) => [
        IPCValidation.TagID(TagID),
        IPCValidation.TagDisplay(Display),
      ],
      (TagID: number, Display: string) => TagManager.SetDisplay(TagID, Display)
    )
  );

  RPC.handle(
    'Tags:SetScope',
    createTupleHandler<
      [number, { Workspace: boolean; Groups: number[]; Clients: string[] }],
      unknown
    >(
      (TagID: unknown, Scope: unknown) => [
        IPCValidation.TagID(TagID),
        IPCValidation.TagScope(Scope),
      ],
      (TagID: number, Scope: { Workspace: boolean; Groups: number[]; Clients: string[] }) =>
        TagManager.SetScope(TagID, Scope)
    )
  );

  RPC.handle('Tags:SetOrder', async (_Event: unknown, OrderedTagIDs: unknown) => {
    if (!Array.isArray(OrderedTagIDs)) return ['Invalid order', null];

    let ParsedTagIDs: number[];
    try {
      ParsedTagIDs = OrderedTagIDs.map((TagID) => IPCValidation.TagID(TagID, 'TagID'));
    } catch (error) {
      return validationErrorTuple(error, false);
    }

    const Result = await TagManager.SetOrder(Array.from(new Set(ParsedTagIDs)));
    if (!Result.ok) {
      return [
        Result.errors && Result.errors[0] ? Result.errors[0] : 'Failed to reorder tags',
        null,
      ];
    }
    return [null, true];
  });

  RPC.handle(
    'Tags:Delete',
    createTupleHandler<[number], unknown>(
      (TagID: unknown) => IPCValidation.TagID(TagID),
      (TagID: number) => TagManager.Delete(TagID),
      { invalidFallback: false }
    )
  );
}

export { register };
