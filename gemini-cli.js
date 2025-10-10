const os = require("os");
const path = require("path");
const fs = require("fs/promises");

const OAUTH_FILE = path.join(os.homedir(), ".gemini", "oauth_creds.json");

// Type enum equivalent in JavaScript
const Type = {
  TYPE_UNSPECIFIED: "TYPE_UNSPECIFIED",
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
  NULL: "NULL",
};

/**
 * Transform the type field from an array of types to an array of anyOf fields.
 * @param {string[]} typeList - List of types
 * @param {Object} resultingSchema - The schema object to modify
 */
function flattenTypeArrayToAnyOf(typeList, resultingSchema) {
  if (typeList.includes("null")) {
    resultingSchema["nullable"] = true;
  }
  const listWithoutNull = typeList.filter((type) => type !== "null");

  if (listWithoutNull.length === 1) {
    const upperCaseType = listWithoutNull[0].toUpperCase();
    resultingSchema["type"] = Object.values(Type).includes(upperCaseType)
      ? upperCaseType
      : Type.TYPE_UNSPECIFIED;
  } else {
    resultingSchema["anyOf"] = [];
    for (const i of listWithoutNull) {
      const upperCaseType = i.toUpperCase();
      resultingSchema["anyOf"].push({
        type: Object.values(Type).includes(upperCaseType)
          ? upperCaseType
          : Type.TYPE_UNSPECIFIED,
      });
    }
  }
}

/**
 * Process a JSON schema to make it compatible with the GenAI API
 * @param {Object} _jsonSchema - The JSON schema to process
 * @returns {Object} - The processed schema
 */
function processJsonSchema(_jsonSchema) {
  const genAISchema = {};
  const schemaFieldNames = ["items"];
  const listSchemaFieldNames = ["anyOf"];
  const dictSchemaFieldNames = ["properties"];

  if (_jsonSchema["type"] && _jsonSchema["anyOf"]) {
    throw new Error("type and anyOf cannot be both populated.");
  }

  /*
  This is to handle the nullable array or object. The _jsonSchema will
  be in the format of {anyOf: [{type: 'null'}, {type: 'object'}]}. The
  logic is to check if anyOf has 2 elements and one of the element is null,
  if so, the anyOf field is unnecessary, so we need to get rid of the anyOf
  field and make the schema nullable. Then use the other element as the new
  _jsonSchema for processing. This is because the backend doesn't have a null
  type.
  */
  const incomingAnyOf = _jsonSchema["anyOf"];
  if (
    incomingAnyOf != null &&
    Array.isArray(incomingAnyOf) &&
    incomingAnyOf.length == 2
  ) {
    if (incomingAnyOf[0] && incomingAnyOf[0]["type"] === "null") {
      genAISchema["nullable"] = true;
      _jsonSchema = incomingAnyOf[1];
    } else if (incomingAnyOf[1] && incomingAnyOf[1]["type"] === "null") {
      genAISchema["nullable"] = true;
      _jsonSchema = incomingAnyOf[0];
    }
  }

  if (_jsonSchema["type"] && Array.isArray(_jsonSchema["type"])) {
    flattenTypeArrayToAnyOf(_jsonSchema["type"], genAISchema);
  }

  for (const [fieldName, fieldValue] of Object.entries(_jsonSchema)) {
    // Skip if the fieldValue is undefined or null.
    if (fieldValue == null) {
      continue;
    }

    if (fieldName == "type") {
      if (fieldValue === "null") {
        throw new Error(
          "type: null can not be the only possible type for the field."
        );
      }
      if (Array.isArray(fieldValue)) {
        // we have already handled the type field with array of types in the
        // beginning of this function.
        continue;
      }
      const upperCaseValue = fieldValue.toUpperCase();
      genAISchema["type"] = Object.values(Type).includes(upperCaseValue)
        ? upperCaseValue
        : Type.TYPE_UNSPECIFIED;
    } else if (schemaFieldNames.includes(fieldName)) {
      genAISchema[fieldName] = processJsonSchema(fieldValue);
    } else if (listSchemaFieldNames.includes(fieldName)) {
      const listSchemaFieldValue = [];
      for (const item of fieldValue) {
        if (item["type"] == "null") {
          genAISchema["nullable"] = true;
          continue;
        }
        listSchemaFieldValue.push(processJsonSchema(item));
      }
      genAISchema[fieldName] = listSchemaFieldValue;
    } else if (dictSchemaFieldNames.includes(fieldName)) {
      const dictSchemaFieldValue = {};
      for (const [key, value] of Object.entries(fieldValue)) {
        dictSchemaFieldValue[key] = processJsonSchema(value);
      }
      genAISchema[fieldName] = dictSchemaFieldValue;
    } else {
      // additionalProperties is not included in JSONSchema, skipping it.
      if (fieldName === "additionalProperties") {
        continue;
      }
      genAISchema[fieldName] = fieldValue;
    }
  }
  return genAISchema;
}

/**
 * Transform a tool object
 * @param {Object} tool - The tool object to transform
 * @returns {Object} - The transformed tool object
 */
function tTool(tool) {
  if (tool.functionDeclarations) {
    for (const functionDeclaration of tool.functionDeclarations) {
      if (functionDeclaration.parameters) {
        if (!Object.keys(functionDeclaration.parameters).includes("$schema")) {
          functionDeclaration.parameters = processJsonSchema(
            functionDeclaration.parameters
          );
        } else {
          if (!functionDeclaration.parametersJsonSchema) {
            functionDeclaration.parametersJsonSchema =
              functionDeclaration.parameters;
            delete functionDeclaration.parameters;
          }
        }
      }
      if (functionDeclaration.response) {
        if (!Object.keys(functionDeclaration.response).includes("$schema")) {
          functionDeclaration.response = processJsonSchema(
            functionDeclaration.response
          );
        } else {
          if (!functionDeclaration.responseJsonSchema) {
            functionDeclaration.responseJsonSchema =
              functionDeclaration.response;
            delete functionDeclaration.response;
          }
        }
      }
    }
  }
  return tool;
}

class GeminiCLITransformer {
  name = "gemini-cli";

  constructor(options) {
    this.options = options;
    try {
      this.oauth_creds = require(OAUTH_FILE);
    } catch {}
  }

  async transformRequestIn(request, provider) {
    if (this.oauth_creds && this.oauth_creds.expiry_date < +new Date()) {
      await this.refreshToken(this.oauth_creds.refresh_token);
    }
    const tools = [];
    const functionDeclarations = request.tools
      ?.filter((tool) => tool.function.name !== "web_search")
      ?.map((tool) => {
        return {
          name: tool.function.name,
          description: tool.function.description,
          parametersJsonSchema: tool.function.parameters,
        };
      });
    if (functionDeclarations?.length) {
      tools.push(
        tTool({
          functionDeclarations,
        })
      );
    }
    const webSearch = request.tools?.find(
      (tool) => tool.function.name === "web_search"
    );
    if (webSearch) {
      tools.push({
        googleSearch: {},
      });
    }
    return {
      body: {
        request: {

          contents: request.messages.map((message) => {
            let role;
            if (message.role === "assistant") {
              role = "model";
            } else if (["user", "system", "tool"].includes(message.role)) {
              role = "user";
            } else {
              role = "user"; // Default to user if role is not recognized
            }

            const parts = [];

            // 1️⃣ Normalize message.content
            if (typeof message.content === "string") {
              parts.push({ text: message.content });
            } else if (Array.isArray(message.content)) {
              for (const c of message.content) {
                if (!c) continue;
                if (c.type === "text" && c.text) {
                  parts.push({ text: c.text });
                } else if (c.type === "image_url" && c.image_url?.url) {
                  if (c.image_url.url.startsWith("http")) {
                    parts.push({
                      file_data: { mime_type: c.media_type, file_uri: c.image_url.url },
                    });
                  } else {
                    parts.push({
                      inlineData: { mime_type: c.media_type, data: c.image_url.url.split(",").pop() },
                    });
                  }
                }
              }
            } else if (message.content && typeof message.content === "object") {
              // Object like { text: "..." }
              if (message.content.text) {
                parts.push({ text: message.content.text });
              } else {
                parts.push({ text: JSON.stringify(message.content) });
              }
            }

            // 2️⃣ Add tool calls
            if (Array.isArray(message.tool_calls)) {
              for (const t of message.tool_calls) {
                parts.push({
                  functionCall: {
                    id: t.id || `tool_${Math.random().toString(36).slice(2, 15)}`,
                    name: t.function.name,
                    args: JSON.parse(t.function.arguments || "{}"),
                  },
                });
              }
            }

            // 3️⃣ Ensure at least one part exists
            if (parts.length === 0) {
              parts.push({ text: "" });
            }

            return {
              role,
              parts,
            };
          }),
          tools: tools.length ? tools : undefined,
        },
        model: request.model,
        project: this.options?.project,
      },
      config: {
        url: new URL(
          `https://cloudcode-pa.googleapis.com/v1internal:${
            request.stream ? "streamGenerateContent?alt=sse" : "generateContent"
          }`
        ),
        headers: {
          Authorization: `Bearer ${this.oauth_creds.access_token}`,
        },
      },
    };
  }

  async transformResponseOut(response) {
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      let jsonResponse = await response.json();
      jsonResponse = jsonResponse.response;
      const tool_calls = jsonResponse.candidates[0].content.parts
        ?.filter((part) => part.functionCall)
        ?.map((part) => ({
          id:
            part.functionCall?.id ||
            `tool_${Math.random().toString(36).substring(2, 15)}`,
          type: "function",
          function: {
            name: part.functionCall?.name,
            arguments: JSON.stringify(part.functionCall?.args || {}),
          },
        }));
      const res = {
        id: jsonResponse.responseId,
        choices: [
          {
            finish_reason:
              jsonResponse.candidates[0].finishReason?.toLowerCase() || null,
            index: 0,
            message: {
              content: jsonResponse.candidates[0].content.parts
                .filter((part) => part.text)
                .map((part) => part.text)
                .join("\n"),
              role: "assistant",
              tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
            },
          },
        ],
        created: parseInt(new Date().getTime() / 1000 + "", 10),
        model: jsonResponse.modelVersion,
        object: "chat.completion",
        usage: {
          completion_tokens: jsonResponse.usageMetadata.candidatesTokenCount,
          prompt_tokens: jsonResponse.usageMetadata.promptTokenCount,
          total_tokens: jsonResponse.usageMetadata.totalTokenCount,
        },
      };
      return new Response(JSON.stringify(res), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else if (response.headers.get("Content-Type")?.includes("stream")) {
      if (!response.body) {
        return response;
      }

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      const processLine = (line, controller) => {
        if (line.startsWith("data: ")) {
          const chunkStr = line.slice(6).trim();
          if (chunkStr) {
            this.logger.debug({ chunkStr }, "gemini-cli chunk:");
            try {
              let chunk = JSON.parse(chunkStr);
              chunk = chunk.response;
              const tool_calls = chunk.candidates[0].content.parts
                ?.filter((part) => part.functionCall)
                ?.map((part) => ({
                  id:
                    part.functionCall?.id ||
                    `tool_${Math.random().toString(36).substring(2, 15)}`,
                  type: "function",
                  function: {
                    name: part.functionCall?.name,
                    arguments: JSON.stringify(part.functionCall?.args || {}),
                  },
                }));
              const res = {
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      content: chunk.candidates[0].content.parts
                        ?.filter((part) => part.text)
                        ?.map((part) => part.text)
                        ?.join("\n"),
                      tool_calls:
                        tool_calls.length > 0 ? tool_calls : undefined,
                    },
                    finish_reason:
                      chunk.candidates[0].finishReason?.toLowerCase() || null,
                    index:
                      chunk.candidates[0].index || tool_calls.length > 0
                        ? 1
                        : 0,
                    logprobs: null,
                  },
                ],
                created: parseInt(new Date().getTime() / 1000 + "", 10),
                id: chunk.responseId || "",
                model: chunk.modelVersion || "",
                object: "chat.completion.chunk",
                system_fingerprint: "fp_a49d71b8a1",
                usage: {
                  completion_tokens: chunk.usageMetadata.candidatesTokenCount,
                  prompt_tokens: chunk.usageMetadata.promptTokenCount,
                  total_tokens: chunk.usageMetadata.totalTokenCount,
                },
              };
              if (
                chunk.candidates[0]?.groundingMetadata?.groundingChunks?.length
              ) {
                res.choices[0].delta.annotations =
                  chunk.candidates[0].groundingMetadata.groundingChunks.map(
                    (groundingChunk, index) => {
                      const support =
                        chunk.candidates[0]?.groundingMetadata?.groundingSupports?.filter(
                          (item) => item.groundingChunkIndices.includes(index)
                        );
                      return {
                        type: "url_citation",
                        url_citation: {
                          url: groundingChunk.web.uri,
                          title: groundingChunk.web.title,
                          content: support?.[0].segment.text,
                          start_index: support?.[0].segment.startIndex,
                          end_index: support?.[0].segment.endIndex,
                        },
                      };
                    }
                  );
              }
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(res)}\n\n`)
              );
            } catch (error) {
              this.logger.error(
                { chunkStr, error },
                "Error parsing Gemini stream chunk"
              );
            }
          }
        }
      };

      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body.getReader();
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (buffer) {
                  processLine(buffer, controller);
                }
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");

              buffer = lines.pop() || "";

              for (const line of lines) {
                processLine(line, controller);
              }
            }
          } catch (error) {
            controller.error(error);
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  }

  refreshToken(refresh_token) {
    return fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id:
          "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
        client_secret: "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",
        refresh_token: refresh_token,
        grant_type: "refresh_token",
      }),
    })
      .then((response) => response.json())
      .then(async (data) => {
        data.expiry_date =
          new Date().getTime() + data.expires_in * 1000 - 1000 * 60;
        data.refresh_token = refresh_token;
        delete data.expires_in;
        this.oauth_creds = data;
        await fs.writeFile(OAUTH_FILE, JSON.stringify(data, null, 2));
      });
  }
}

module.exports = GeminiCLITransformer;