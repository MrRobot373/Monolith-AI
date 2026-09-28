"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChatView } from "@/components/chat/chat-view";

/**
 * One route for new and existing chats. When a new chat is created we update the URL
 * without remounting, so the streaming reply isn't interrupted.
 */
export default function ChatPage() {
  const params = useParams<{ id?: string[] }>();
  const paramId = params.id?.[0];
  const [localId, setLocalId] = useState<string | null>(null);
  const [fresh, setFresh] = useState(0);
  const prevParam = useRef(paramId);

  // "New chat" clicked while on a chat created in this view: the URL goes from /app/chat/:id back to /app/chat.
  useEffect(() => {
    if (prevParam.current && !paramId) {
      setLocalId(null);
      setFresh((n) => n + 1);
    }
    prevParam.current = paramId;
  }, [paramId]);

  const isLocal = !paramId || paramId === localId;
  return (
    <ChatView
      key={isLocal ? `new-${fresh}` : paramId}
      chatId={isLocal ? undefined : paramId}
      onCreated={(id) => {
        setLocalId(id);
        window.history.replaceState(null, "", `/app/chat/${id}`);
      }}
    />
  );
}
