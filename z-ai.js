class ZThinkingTransformer {
  constructor(options = {}) {
    this.name = 'z-thinking';
    this.options = options;
  }

  async transformRequestIn(request, model) {
    // Request is already parsed JSON, not a Request object
    console.log('[Z-THINKING] transformRequestIn called');

    // Add thinking_tokens parameter to enable reasoning content
    request.thinking_tokens = true;

    return request;
  }

  async transformResponseOut(response) {
    const contentType = response.headers.get("Content-Type");
    console.log('[Z-THINKING] transformResponseOut called, content-type:', contentType);

    if (contentType?.includes("application/json")) {
      // Handle non-streaming response
      const jsonResponse = await response.json();
      const choice = jsonResponse.choices?.[0];

      if (choice?.message?.reasoning_content) {
        // Transform reasoning_content to thinking format for Anthropic compatibility
        const thinkingContent = choice.message.reasoning_content;

        // Add thinking field to message
        choice.message.thinking = {
          content: thinkingContent
        };

        // Remove the reasoning_content field
        delete choice.message.reasoning_content;
      }

      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }
    else if (contentType?.includes("stream")) {
      // Handle streaming response
      const { TextEncoder, TextDecoder } = globalThis;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      // State needs to be in closure, not on 'this'
      let thinkingStarted = false;
      let thinkingEnded = false;
      let buffer = ''; // Buffer for incomplete lines

      const transformStream = new TransformStream({
        async transform(chunk, controller) {
          const text = decoder.decode(chunk, { stream: true });
          buffer += text;
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const chunkStr = line.slice(6).trim();
              if (chunkStr && chunkStr !== "[DONE]") {
                try {
                  let data = JSON.parse(chunkStr);
                  const delta = data.choices?.[0]?.delta;

                  if (delta?.reasoning_content) {
                    // Handle streaming reasoning content - transform to thinking format
                    const reasoningContent = delta.reasoning_content;
                    console.log('[Z-THINKING] Found reasoning_content:', reasoningContent.substring(0, 50));

                    // Transform to Anthropic thinking format: delta.thinking.content
                    const transformedData = {
                      ...data,
                      choices: [{
                        ...data.choices[0],
                        delta: {
                          ...delta,
                          thinking: {
                            content: reasoningContent
                          }
                        }
                      }]
                    };

                    // Remove reasoning_content as it's now in thinking
                    delete transformedData.choices[0].delta.reasoning_content;

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(transformedData)}\n\n`));
                    continue;
                  }

                  // Emit the original chunk (for regular content deltas)
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

                } catch (error) {
                  console.error('Error processing streaming chunk:', error);
                  // Pass through original chunk on error
                  controller.enqueue(encoder.encode(`data: ${chunkStr}\n\n`));
                }
              } else if (chunkStr === "[DONE]") {
                // Reset state for next response
                thinkingStarted = false;
                thinkingEnded = false;
                controller.enqueue(encoder.encode(`data: ${chunkStr}\n\n`));
              }
            } else if (line.trim()) {
              controller.enqueue(encoder.encode(`${line}\n`));
            }
          }
        }
      });

      return new Response(response.body.pipeThrough(transformStream), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    return response;
  }
}

module.exports = ZThinkingTransformer;