export function hasRemoteUrlCredentials(value: string): boolean {
  const url = parseHttpUrl(value);
  return url !== undefined && (url.username.length > 0 || url.password.length > 0);
}

export function isCredentiallessHttpUrl(value: string): boolean {
  const url = parseHttpUrl(value);
  return url !== undefined && url.username.length === 0 && url.password.length === 0;
}

export function isSafeSourceUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f-\u009f\s<>]/.test(trimmed)) {
    return false;
  }

  return isCredentiallessHttpUrl(trimmed);
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
