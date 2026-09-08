export type MinimizeClassifier = 'RESOLVED' | 'OUTDATED';

export interface GraphqlClient {
  graphql: <T = unknown>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}

const MINIMIZE_MUTATION = `mutation($subjectId: ID!, $classifier: ReportedContentClassifiers!) {
  minimizeComment(input: { subjectId: $subjectId, classifier: $classifier }) {
    minimizedComment { isMinimized }
  }
}`;

const UNMINIMIZE_MUTATION = `mutation($subjectId: ID!) {
  unminimizeComment(input: { subjectId: $subjectId }) {
    unminimizedComment { ... on IssueComment { id } }
  }
}`;

export const minimizeComment = async (
  octokit: GraphqlClient,
  subjectId: string,
  classifier: MinimizeClassifier,
): Promise<void> => {
  await octokit.graphql(MINIMIZE_MUTATION, { subjectId, classifier });
};

export const unminimizeComment = async (octokit: GraphqlClient, subjectId: string): Promise<void> => {
  await octokit.graphql(UNMINIMIZE_MUTATION, { subjectId });
};
