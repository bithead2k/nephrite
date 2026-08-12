/** Never replace a saved workspace with the empty shell shown during startup. */
export function canPersistSession(vaultOpen: boolean, restoringSession: boolean): boolean {
  return vaultOpen && !restoringSession;
}
