export type LabelLike = string | { name?: string | null } | null;

export interface LabelRemovalClient {
  rest: {
    issues: {
      removeLabel: (params: { owner: string; repo: string; issue_number: number; name: string }) => Promise<unknown>;
    };
  };
}

type LabelRemoval = Parameters<LabelRemovalClient['rest']['issues']['removeLabel']>[0];

// A label that is already absent is the requested end state, not a failure.
export const removeLabel = async (octokit: LabelRemovalClient, removal: LabelRemoval): Promise<void> => {
  try {
    await octokit.rest.issues.removeLabel(removal);
  } catch (error) {
    if ((error as { status?: unknown }).status !== 404) {
      throw error;
    }
  }
};

// Normalizes a label list to an array of string names. Handles both shapes
// GitHub returns: REST `listForRepo` mixes strings with `{ name?: string }`
// objects, while webhook payloads carry the object form only. Labels whose
// name is missing or null are dropped.
export const labelNames = (labels: readonly LabelLike[] | undefined): string[] => {
  return (labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name): name is string => typeof name === 'string');
};
