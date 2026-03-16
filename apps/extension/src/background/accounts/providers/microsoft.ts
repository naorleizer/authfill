import { getMicrosoftAccessToken } from "@extension/background/auth/microsoft";
import { syncAccounts } from "@extension/background/accounts";
import { addEmails } from "@extension/background/utils/email";
import type { EmailBase } from "@extension/types/email";
import type { MicrosoftAccountConfig } from "@extension/utils/storage";

const POLL_INTERVAL = 5_000;
const MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/messages";

interface GraphMessage {
  subject: string;
  from: { emailAddress: { address: string; name: string } };
  toRecipients: { emailAddress: { address: string } }[];
  body: { contentType: string; content: string };
  receivedDateTime: string;
}

export class MicrosoftAccount {
  config: MicrosoftAccountConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastCheck: string | null = null;

  constructor(config: MicrosoftAccountConfig) {
    this.config = config;
  }

  public async connect() {
    if (this.pollTimer) return;
    await this.fetchEmails();
    this.pollTimer = setInterval(() => this.fetchEmails(), POLL_INTERVAL);
  }

  public disconnect() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.info(`[${this.config.id}] Microsoft account disconnected`);
  }

  public toConfig(): MicrosoftAccountConfig {
    return this.config;
  }

  private async fetchEmails() {
    let accessToken: string;
    try {
      accessToken = await getMicrosoftAccessToken(this.config);
    } catch (err) {
      console.error(`[${this.config.id}] Token refresh failed:`, err);
      return;
    }

    const params = new URLSearchParams({
      $top: "10",
      $orderby: "receivedDateTime desc",
      $select: "subject,from,toRecipients,body,receivedDateTime",
    });

    if (this.lastCheck) {
      params.set(
        "$filter",
        `receivedDateTime gt ${this.lastCheck}`,
      );
    }

    try {
      const res = await fetch(`${MESSAGES_URL}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        console.error(`[${this.config.id}] Graph API error: ${res.status}`);
        return;
      }

      const data: { value: GraphMessage[] } = await res.json();

      if (data.value.length === 0) return;

      this.lastCheck = new Date().toISOString();

      // Update config with potentially refreshed token
      await syncAccounts();

      const emails: EmailBase[] = data.value.map((msg) => ({
        from: msg.from.emailAddress.name
          ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`
          : msg.from.emailAddress.address,
        to: this.config.email,
        subject: msg.subject,
        html: msg.body.contentType === "html" ? msg.body.content : undefined,
        text: msg.body.contentType === "text" ? msg.body.content : undefined,
        date: msg.receivedDateTime,
      }));

      addEmails(emails, this.config.id);
    } catch (err) {
      console.error(`[${this.config.id}] Failed to fetch emails:`, err);
    }
  }
}
