import type { Api } from "grammy";
import { events } from "../../opencode/events.js";
import { opencode } from "../../opencode/client.js";
import {
  getTopicForSession,
  updateTopicName,
  formatTopicName,
  effectiveDir,
} from "../../services/topic-store.js";
import { logger } from "../../utils/logger.js";
import type { OcEvent } from "../../opencode/types.js";

export function registerTopicSyncHandler(api: Api): () => void {
  return events.on("session.updated", (event: OcEvent) => {
    const sessionId = event.properties?.["sessionID"] as string | undefined;
    if (!sessionId) return;

    const entry = getTopicForSession(sessionId);
    if (!entry) return;

    opencode
      .getSession(sessionId)
      .then((session) => {
        const title = session.title || session.slug;
        const newName = formatTopicName(effectiveDir(sessionId, session.directory), title);

        if (newName === entry.name) return;

        return api
          .editForumTopic(entry.chatId, entry.topicId, { name: newName })
          .then(() => {
            updateTopicName(sessionId, newName);
            logger.debug("Topic name synced", { sessionId, name: newName });
          });
      })
      .catch((err) => {
        logger.debug("Failed to sync topic name", { sessionId, error: String(err) });
      });
  });
}
