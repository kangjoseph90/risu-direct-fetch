// ==UserScript==
// @name         RisuAI Direct Fetch (Bypass Proxy)
// @namespace    https://github.com/kangjoseph90/risu-direct-fetch
// @version      1.2.0
// @description  RisuAI의 공유 프록시(sv.risuai.xyz/proxy2)를 우회하여 LLM API에 직접 요청합니다.
//               프록시를 거치지 않으므로 Origin 헤더 노출 없이 사용자 본인 IP로 요청됩니다.
// @author       kangjoseph90
// @match        https://risuai.xyz/*
// @match        https://nightly.risuai.xyz/*
// @match        https://stable.risuai.xyz/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  /**
   * 응답 헤더 문자열을 파싱하여 Headers 객체로 변환합니다.
   */
  function parseResponseHeaders(rawHeaders) {
    const headers = {};
    if (!rawHeaders) return headers;
    const lines = rawHeaders.trim().split(/\r?\n/);
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.substring(0, idx).trim().toLowerCase();
        const value = line.substring(idx + 1).trim();
        headers[key] = value;
      }
    }
    return headers;
  }

  /**
   * init.headers를 일반 객체로 변환합니다.
   */
  function normalizeHeaders(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) {
      const obj = {};
      for (const [k, v] of headers.entries()) obj[k] = v;
      return obj;
    }
    if (Array.isArray(headers)) {
      const obj = {};
      for (const [k, v] of headers) obj[k] = v;
      return obj;
    }
    return { ...headers };
  }

  /**
   * init.body를 GM_xmlhttpRequest가 수용할 수 있는 형태로 변환합니다.
   */
  function normalizeBody(body) {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return new Blob([body]);
    if (body instanceof ArrayBuffer) return new Blob([new Uint8Array(body)]);
    return body.toString();
  }

  /**
   * GM_xmlhttpRequest를 표준 fetch() Response로 래핑합니다.
   *
   * 스트리밍 방식: responseText 누적 + onprogress 청킹 (가장 호환성 높은 방식)
   * responseType: 'stream'은 Tampermonkey 버전별 지원이 불안정하므로 사용하지 않습니다.
   */
  function gmFetch(url, init = {}) {
    return new Promise((resolve, reject) => {
      const method = (init.method || "GET").toUpperCase();
      const headerObj = normalizeHeaders(init.headers);
      const data = normalizeBody(init.body);

      // Origin, Referer 명시적 제거
      delete headerObj["Origin"];
      delete headerObj["Referer"];

      let resolved = false;
      let streamController = null;
      let lastIndex = 0;
      let xhrHandle = null;

      const stream = new ReadableStream({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          if (xhrHandle && xhrHandle.abort) xhrHandle.abort();
        },
      });

      // AbortSignal 지원
      if (init.signal) {
        if (init.signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init.signal.addEventListener("abort", () => {
          if (xhrHandle && xhrHandle.abort) xhrHandle.abort();
        });
      }

      function resolveWithHeaders(response) {
        if (resolved) return;
        resolved = true;

        const headers = parseResponseHeaders(response.responseHeaders);
        const res = new Response(stream, {
          status: response.status || 200,
          statusText: response.statusText || "",
          headers: new Headers(headers),
        });

        Object.defineProperty(res, "url", {
          value: response.finalUrl || url,
        });

        resolve(res);
      }

      function pushChunk(responseText) {
        if (!responseText || !streamController) return;
        const newData = responseText.substring(lastIndex);
        if (newData.length > 0) {
          lastIndex = responseText.length;
          streamController.enqueue(new TextEncoder().encode(newData));
        }
      }

      function closeStream() {
        if (streamController) {
          try {
            streamController.close();
          } catch (e) {
            /* already closed */
          }
          streamController = null;
        }
      }

      xhrHandle = GM_xmlhttpRequest({
        method: method,
        url: url,
        headers: headerObj,
        data: data,
        anonymous: true,
        // responseType을 지정하지 않아 responseText 기반으로 동작

        onreadystatechange(response) {
          // readyState 2 = HEADERS_RECEIVED — 헤더가 도착하면 즉시 Response를 resolve
          if (response.readyState >= 2 && !resolved) {
            resolveWithHeaders(response);
          }
        },

        onprogress(response) {
          // 헤더가 아직 안 왔으면 여기서 resolve
          if (!resolved) {
            resolveWithHeaders(response);
          }
          // 새로 도착한 텍스트를 스트림에 push
          pushChunk(response.responseText);
        },

        onload(response) {
          // 헤더가 아직 안 왔으면 (작은 응답) 여기서 resolve
          if (!resolved) {
            resolveWithHeaders(response);
          }
          // 남은 데이터 push
          pushChunk(response.responseText);
          // 스트림 종료
          closeStream();
        },

        onerror(response) {
          closeStream();
          if (!resolved) {
            reject(
              new Error(
                "Network error: " +
                  (response.statusText || response.error || "Unknown"),
              ),
            );
          }
        },

        ontimeout() {
          closeStream();
          if (!resolved) {
            reject(new Error("Request timed out"));
          }
        },

        onabort() {
          closeStream();
          if (!resolved) {
            reject(new DOMException("Aborted", "AbortError"));
          }
        },
      });
    });
  }

  // --- RisuAI에 주입 ---
  // unsafeWindow를 사용해야 Tampermonkey 샌드박스 밖의 실제 페이지 window에 접근 가능
  Object.defineProperty(unsafeWindow, "userScriptFetch", {
    value: gmFetch,
    writable: false,
    configurable: false,
  });

  console.log(
    "%c[RisuAI Direct Fetch] %cv1.2.0 Loaded — 프록시를 우회하여 직접 요청합니다.",
    "color: #4CAF50; font-weight: bold;",
    "color: inherit;",
  );
  console.log(
    "%c[RisuAI Direct Fetch] %c프로바이더에게 보이는 것: 사용자 본인 IP, Origin 헤더 없음",
    "color: #4CAF50; font-weight: bold;",
    "color: #888;",
  );
})();
