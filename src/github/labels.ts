type LabelLike = string | { name?: string | null };

// Normalizes a label list to an array of string names. Handles both shapes
// GitHub returns: REST `listForRepo` mixes strings with `{ name?: string }`
// objects, while webhook payloads carry the object form only. Labels whose
// name is missing or null are dropped.
export const labelNames = (labels: readonly LabelLike[] | undefined): string[] => {
  return (labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((name): name is string => typeof name === 'string');
};
