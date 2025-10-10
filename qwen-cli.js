const os = require("os");
const path = require("path");
const fs = require("fs/promises");

const OAUTH_FILE = path.join(os.homedir(), ".qwen", "oauth_creds.json");

class QwenCLITransformer {
  name = "qwen-cli";

  // Normalize messages so `messages[n].content` is either a string or
  // an array of { type: "text", text: "..." } blocks (we choose array form).
  normalizeMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map((m) => {
      const content = m.content;
      let normalized;

      if (typeof content === "string") {
        normalized = [{ type: "text", text: content }];
      } else if (Array.isArray(content)) {
        normalized = content.map((item) => {
          if (typeof item === "string") return { type: "text", text: item };
          if (item && typeof item === "object") {
            // already block-like?
            if (item.type === "text" && typeof item.text === "string")
              return { type: "text", text: item.text };
            if (typeof item.text === "string") return { type: "text", text: item.text };
            // fallback: stringify object
            return { type: "text", text: JSON.stringify(item) };
          }
          return { type: "text", text: String(item) };
        });
      } else if (content && typeof content === "object") {
        if (typeof content.text === "string") {
          normalized = [{ type: "text", text: content.text }];
        } else {
          normalized = [{ type: "text", text: JSON.stringify(content) }];
        }
      } else {
        // ensure at least one text block
        normalized = [{ type: "text", text: "" }];
      }

      return {
        ...m,
        content: normalized,
      };
    });
  }

  async transformRequestIn(request, provider) {
    if (!this.oauth_creds) {
      await this.getOauthCreds();
    }
    if (this.oauth_creds && this.oauth_creds.expiry_date < +new Date()) {
      await this.refreshToken(this.oauth_creds.refresh_token);
    }
    if (request.stream) {
      request.stream_options = {
        include_usage: true,
      };
    }

    // Normalize request.messages for Qwen's expected schema
    if (Array.isArray(request.messages)) {
      request.messages = this.normalizeMessages(request.messages);
    }

    return {
      body: request,
      config: {
        headers: {
          Authorization: `Bearer ${this.oauth_creds.access_token}`,
          "User-Agent": "QwenCode/v22.12.0 (darwin; arm64)",
        },
      },
    };
  }

  refreshToken(refresh_token) {
    const urlencoded = new URLSearchParams();
    urlencoded.append("client_id", "f0304373b74a44d2b584a3fb70ca9e56");
    urlencoded.append("refresh_token", refresh_token);
    urlencoded.append("grant_type", "refresh_token");
    return fetch("https://chat.qwen.ai/api/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: urlencoded,
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

  async getOauthCreds() {
    try {
      const data = await fs.readFile(OAUTH_FILE);
      this.oauth_creds = JSON.parse(data);
    } catch (e) {}
  }
}

module.exports = QwenCLITransformer;
