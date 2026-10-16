// Building blocks for audit log summaries (pure).
//
// A summary is a short run of segments, so the renderer can highlight the
// names in it without parsing prose: `Line(Device('Logitech Mouse'), ' moved
// from ', Value('Port 1'), ' → ', Value('Port 3'))`.
import type { AuditSegment } from '@showtrak/protocol';

export type SummaryPart = string | AuditSegment | null | undefined | false;

export function Entity(Text: unknown): AuditSegment {
  return { T: TextOf(Text), H: 'entity' };
}

export function Device(Text: unknown): AuditSegment {
  return { T: TextOf(Text), H: 'device' };
}

export function Value(Text: unknown): AuditSegment {
  return { T: TextOf(Text), H: 'value' };
}

// Join parts into segments: empty parts are dropped and neighbouring plain
// strings merge, so the stored summary stays as small as the sentence.
export function Line(...Parts: SummaryPart[]): AuditSegment[] {
  const Segments: AuditSegment[] = [];
  for (const Part of Parts) {
    if (Part === null || Part === undefined || Part === false) continue;
    const Segment: AuditSegment = typeof Part === 'string' ? { T: Part } : Part;
    if (!Segment.T) continue;
    const Last = Segments[Segments.length - 1];
    if (Last && !Last.H && !Segment.H) {
      Last.T += Segment.T;
      continue;
    }
    Segments.push(Segment.H ? { T: Segment.T, H: Segment.H } : { T: Segment.T });
  }
  return Segments;
}

export function PlainText(Segments: readonly AuditSegment[]): string {
  return Segments.map((Segment) => Segment.T).join('');
}

function TextOf(Value: unknown): string {
  if (Value === null || Value === undefined) return '';
  return String(Value).trim();
}
