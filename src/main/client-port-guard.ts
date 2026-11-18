// Start-up gate on the client port.
//
// ShowTrak Clients, the Web UI and the SDK all reach the server on one TCP port.
// If another program already holds it, the server is useless: and worse, if it
// went on to advertise itself over Bonjour, clients would connect to that other
// program and sit "connected" without ever appearing for adoption. So start-up
// does not continue until the port is bound. The operator's only choices are
// Retry (after closing whatever holds the port) or Quit.

export interface ClientPortGuardDeps {
  /** The port being bound, for the message. */
  Port: number;
  /** The first bind attempt, already in flight when start-up gets here. */
  Initial: Promise<void>;
  /** Try to bind again. */
  Retry: () => Promise<void>;
  /** Ask the operator; resolves true for Retry, false for Quit. */
  AskRetry: (Title: string, Message: string, Detail: string) => Promise<boolean>;
  Log?: (Message: string, Err?: unknown) => void;
}

export function DescribeBindFailure(
  Port: number,
  Err: unknown
): { Message: string; Detail: string } {
  const Code = (Err as NodeJS.ErrnoException | null)?.code;
  if (Code === 'EADDRINUSE') {
    return {
      Message: `Port ${Port} is already in use by another program.`,
      Detail: `ShowTrak Clients cannot connect to this server until it can use port ${Port}. Close the program using port ${Port}, then select Retry.`,
    };
  }
  return {
    Message: `ShowTrak Server could not use port ${Port}.`,
    Detail: `The port could not be opened (${Code || String(Err)}). ShowTrak Clients cannot connect to this server until it can. Select Retry to try again.`,
  };
}

/**
 * Resolves true once the port is bound, false if the operator chose Quit.
 * Never resolves true without a successful bind.
 */
export async function EnsureClientPortBound(Deps: ClientPortGuardDeps): Promise<boolean> {
  let Attempt = Deps.Initial;
  for (;;) {
    try {
      await Attempt;
      return true;
    } catch (Err) {
      Deps.Log?.(`Could not listen on port ${Deps.Port}:`, Err);
      const { Message, Detail } = DescribeBindFailure(Deps.Port, Err);
      const ShouldRetry = await Deps.AskRetry(
        'ShowTrak Server Cannot Accept Clients',
        Message,
        Detail
      );
      if (!ShouldRetry) return false;
      Attempt = Deps.Retry();
    }
  }
}
