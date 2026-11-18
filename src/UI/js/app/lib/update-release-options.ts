// Pure rules for the client update screen's release picker.
//
// The server marks each release with whether it is a pre-release and whether
// its update channel allows it (`selectable`: pre-releases only on Beta). These
// decide how each option reads, which one is chosen by default, and whether a
// deploy needs the pre-release confirmation. No DOM, so they can be tested.

import type { UpdateReleaseOption } from '@showtrak/protocol';

/** How a release reads in the picker. */
export function GetReleaseOptionLabel(Option: UpdateReleaseOption, DownloadedTag: string): string {
  const Tag = String(Option.tag || '').trim();
  let Label = String(Option.name || Tag).trim() || Tag;
  if (Option.prerelease)
    Label += Option.selectable === false ? ' (pre-release, Beta channel only)' : ' (pre-release)';
  if (DownloadedTag && DownloadedTag === Tag) Label += ' (downloaded)';
  return Label;
}

/** Whether the server's channel lets this option be downloaded and deployed. */
export function IsReleaseOptionSelectable(Option: UpdateReleaseOption | null | undefined): boolean {
  return !!Option && !!Option.tag && Option.selectable !== false;
}

/**
 * The release to select: the operator's choice, else the downloaded build, else
 * the first selectable release (the list arrives newest version first, so on
 * Stable that is the newest full release and on Beta the newest of any kind).
 * A choice the channel does not allow is never kept.
 */
export function PickDefaultReleaseTag(
  Options: ReadonlyArray<UpdateReleaseOption>,
  SelectedTag: string,
  DownloadedTag: string
): string {
  const ByTag = new Map(Options.map((Option) => [String(Option.tag || '').trim(), Option]));
  for (const Tag of [SelectedTag, DownloadedTag]) {
    if (Tag && IsReleaseOptionSelectable(ByTag.get(Tag))) return Tag;
  }
  const First = Options.find((Option) => IsReleaseOptionSelectable(Option));
  return First ? String(First.tag).trim() : '';
}

/** Whether the release with this tag is a pre-release. */
export function IsPrereleaseTag(Options: ReadonlyArray<UpdateReleaseOption>, Tag: string): boolean {
  const Option = Options.find((Entry) => String(Entry.tag || '').trim() === Tag);
  return !!Option && !!Option.prerelease;
}
