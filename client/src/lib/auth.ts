const SESSION_HINT = "kamlife_session";

export function markLoggedIn(): void {
  sessionStorage.setItem(SESSION_HINT, "1");
}

export function markLoggedOut(): void {
  sessionStorage.removeItem(SESSION_HINT);
}

export function hasSessionHint(): boolean {
  return !!sessionStorage.getItem(SESSION_HINT);
}
