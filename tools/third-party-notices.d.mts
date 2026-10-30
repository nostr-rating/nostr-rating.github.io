export interface ThirdPartyPackage {
  name: string;
  version: string;
  license: string;
  /** パッケージにライセンスの本文が無ければ null */
  text: string | null;
}

export function thirdPartyPackages(repo: string, workspaces: string[]): ThirdPartyPackage[];
export function formatNotices(pkgs: ThirdPartyPackage[]): string;
