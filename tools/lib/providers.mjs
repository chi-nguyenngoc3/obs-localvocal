/**
 * providers.mjs — hình dạng wire của từng backend LLM.
 *
 * `cleanup.mjs` chỉ cần: gửi (system, user) đi và nhận lại **một chuỗi text**.
 * Mỗi provider dưới đây khai báo 4 thứ khác nhau giữa các nhà cung cấp:
 *
 *   url()      đường dẫn đầy đủ (Azure nhét deployment + api-version vào URL)
 *   headers()  tên header mang API key khác nhau
 *   body()     Anthropic tách `system` ra trường riêng; OpenAI coi nó là một message
 *   extract()  Anthropic trả `content[].text`; OpenAI trả `choices[0].message.content`
 *
 * Thêm provider mới = thêm một entry, không sửa `callLlm`.
 */

/** Bỏ dấu `/` ở cuối để `${base}/path` không thành `//path`. */
const trimSlash = (u) => u.replace(/\/+$/, "");

/**
 * Anthropic Messages API. Cũng là hình dạng mà `tools/mock-llm` nói,
 * nên mock dùng được mà không cần cấu hình gì thêm.
 */
const anthropic = {
  id: "anthropic",
  /** Key đi qua header `x-api-key`. */
  url: ({ baseUrl }) => `${trimSlash(baseUrl)}/v1/messages`,
  headers: ({ apiKey }) => ({
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  }),
  body: ({ model, maxTokens, system, user }) => ({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  }),
  extract: (data) =>
    Array.isArray(data?.content)
      ? data.content
          .filter((b) => b?.type === "text")
          .map((b) => b.text)
          .join("")
      : null,
};

/**
 * Azure OpenAI. Khác Anthropic ở cả 4 điểm:
 *
 * - URL chứa deployment name và **bắt buộc** có `?api-version=`; thiếu là 404.
 * - Key đi qua header `api-key`, không phải `x-api-key` hay `Authorization`.
 * - Không có trường `system` riêng — system prompt là message đầu `role:"system"`.
 * - Giới hạn token gọi là `max_tokens`, kết quả nằm ở `choices[0].message.content`.
 *
 * `model` bị bỏ qua có chủ ý: Azure chọn model qua deployment trong URL, gửi kèm
 * `model` trong body không có tác dụng và dễ gây hiểu nhầm.
 */
const azureOpenai = {
  id: "azure-openai",
  url: ({ baseUrl, deployment, apiVersion }) =>
    `${trimSlash(baseUrl)}/openai/deployments/${encodeURIComponent(deployment)}` +
    `/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
  headers: ({ apiKey }) => ({
    "Content-Type": "application/json",
    ...(apiKey ? { "api-key": apiKey } : {}),
  }),
  body: ({ maxTokens, system, user }) => ({
    max_tokens: maxTokens,
    // Nhiệt độ 0: đây là việc sửa chính tả, không phải việc sáng tác.
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }),
  extract: (data) => {
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text : null;
  },
};

/**
 * OpenAI-compatible (`/v1/chat/completions` + `Authorization: Bearer`).
 * Dùng cho OpenAI thật, và cho hầu hết gateway nội bộ / LLM local
 * (vLLM, Ollama, LiteLLM, 9router) vì chúng đều bắt chước hình dạng này.
 */
const openai = {
  id: "openai",
  url: ({ baseUrl }) => `${trimSlash(baseUrl)}/v1/chat/completions`,
  headers: ({ apiKey }) => ({
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }),
  body: ({ model, maxTokens, system, user }) => ({
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }),
  extract: azureOpenai.extract,
};

export const PROVIDERS = {
  anthropic,
  "azure-openai": azureOpenai,
  openai,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/**
 * Tra provider theo id, báo lỗi rõ ràng nếu sai.
 *
 * @param {string} id
 * @returns {object} provider
 * @throws {Error} khi id không tồn tại — liệt kê các id hợp lệ.
 */
export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) {
    throw new Error(
      `provider không rõ: "${id}". Hợp lệ: ${PROVIDER_IDS.join(", ")}.`,
    );
  }
  return p;
}
