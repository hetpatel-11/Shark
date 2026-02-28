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
      return {
        ok: false,
        status: response.status,
        data,
        error: typeof data === "object" && data !== null && "error" in data
          ? String((data as { error?: unknown }).error)
          : `Request failed with status ${response.status}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Unknown request failure",
    };
  }
}
