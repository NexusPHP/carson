// Cached identity of the GitHub App the action is currently running as.
// The numeric App ID is intentionally omitted because it is sensitive when
// paired with the App PEM.

export interface AppIdentityData {
  readonly name: string | null | undefined;
  readonly slug: string | null | undefined;
}

class AppIdentity {
  #cached: AppIdentityData | null = null;

  public set(data: AppIdentityData): void {
    this.#cached = data;
  }

  public reset(): void {
    this.#cached = null;
  }

  public get current(): AppIdentityData | null {
    return this.#cached;
  }

  public get name(): string {
    return this.#cached?.name ?? 'Carson';
  }

  public get slug(): string {
    return this.#cached?.slug ?? 'carson';
  }

  public get login(): string {
    return `${this.slug}[bot]`;
  }
}

export const appIdentity = new AppIdentity();
