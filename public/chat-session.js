const prefix = 'sourcepad:general-chat:v1:';

// sessionStorage conserva la conversación en esta pestaña, nunca los tokens.
export function clearChatSessions() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch { /* El navegador puede bloquear el almacenamiento. */ }
}

export function createChatSession(userId) {
  if (typeof userId !== 'string' || !userId) throw new Error('No se pudo identificar la sesión.');
  const key = prefix + userId;
  return {
    load() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(key));
        if (saved?.userId !== userId || !Array.isArray(saved.messages) || typeof saved.draft !== 'string') return null;
        if (!saved.messages.every(message => message && ['user','assistant'].includes(message.role)
          && typeof message.content === 'string' && typeof message.context === 'boolean')) return null;
        return saved;
      } catch { return null; }
    },
    save(messages, draft) {
      try { sessionStorage.setItem(key, JSON.stringify({userId, messages, draft})); return true; }
      catch { return false; }
    },
    clear() {
      try { sessionStorage.removeItem(key); } catch { /* Sin almacenamiento. */ }
    },
  };
}
