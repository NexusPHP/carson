export const ROLES = ['admin', 'maintain', 'write', 'triage', 'read'] as const;

export interface RoleClient {
  rest: {
    repos: {
      getCollaboratorPermissionLevel: (params: { owner: string; repo: string; username: string }) => Promise<{ data: { role_name: string } }>;
    };
  };
}

// author_association hides private org members from an App, so gates use the actual repository role.
export const roleOf = async (octokit: RoleClient, owner: string, repo: string, username: string): Promise<string> => {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });

    return data.role_name;
  } catch {
    return 'none';
  }
};
