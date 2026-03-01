export interface JsonRequestOptions {
  method?: "GET" | "POST" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
}

export interface JsonResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export async function requestJson<T>(
  url: string,
  options: JsonRequestOptions = {},
): Promise<JsonResponse<T>> {
  const maxAttempts = 3;
  let lastFailure: JsonResponse<T> | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      const text = await response.text();
      const data = text.length > 0 ? (JSON.parse(text) as T) : undefined;

      if (!response.ok) {
        const failure: JsonResponse<T> = {
          ok: false,
          status: response.status,
          data,
          error: typeof data === "object" && data !== null && "error" in data
            ? String((data as { error?: unknown }).error)
            : `Request failed with status ${response.status}`,
        };

        lastFailure = failure;
        if (attempt < maxAttempts && shouldRetryStatus(response.status)) {
          await delay(250 * attempt);
          continue;
        }

        return failure;
      }

      return {
        ok: true,
        status: response.status,
        data,
      };
    } catch (error) {
      lastFailure = {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : "Unknown request failure",
      };

      if (attempt < maxAttempts) {
        await delay(250 * attempt);
        continue;
      }
    }
  }

  return lastFailure ?? {
    ok: false,
    status: 0,
    error: "Unknown request failure",
  };
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
