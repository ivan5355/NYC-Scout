import { useState, useEffect, useRef } from 'react';

export default function Scout() {
  const [userId] = useState(() => {
    const stored = localStorage.getItem('nyc_scout_user_id');
    if (stored) return stored;
    const newId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('nyc_scout_user_id', newId);
    return newId;
  });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const messagesEndRef = useRef(null);
  const API_URL = '/api/chat';

  useEffect(() => {
    if (initialized) return;
    setInitialized(true);
    initChat();
  }, [initialized]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const initChat = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi', userId })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setMessages([{
        type: 'assistant',
        content: data.reply,
        category: data.category
      }]);
    } catch (err) {
      console.error('Init error:', err);
      setMessages([{
        type: 'assistant',
        content: 'Something went wrong. Make sure the backend is running.'
      }]);
    }
    setIsLoading(false);
  };

  const sendMessage = async (text) => {
    if (!text) return;

    setIsLoading(true);
    setMessages(prev => [...prev, { type: 'user', content: text }]);

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, userId })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setMessages(prev => [...prev, {
        type: 'assistant',
        content: data.reply,
        category: data.category
      }]);

    } catch (err) {
      console.error('Chat error:', err);
      setMessages(prev => [...prev, {
        type: 'assistant',
        content: 'Something went wrong. Make sure the backend is running.'
      }]);
    }

    setIsLoading(false);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput('');
  };

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <header className="border-b border-white/10 bg-black sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center text-sm font-bold">
              NYC
            </div>
            <div>
              <h1 className="font-bold text-lg">NYC Scout</h1>
              <p className="text-xs text-white/50">Food & events guide</p>
            </div>
          </div>
        </div>
      </header>


      {/* Main Chat Area */}
      <main className="max-w-4xl mx-auto px-4 py-6 pb-32">
        {/* Messages */}
        <div className="space-y-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${msg.type === 'user'
                  ? 'bg-white text-black'
                  : 'bg-white/10 text-white'
                  }`}
              >
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-white/10 rounded-2xl px-4 py-3">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                  <span className="w-2 h-2 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                  <span className="w-2 h-2 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Input Area */}
      <div className="fixed bottom-0 left-0 right-0 bg-black border-t border-white/10">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Try 'best ramen Manhattan' or 'sushi Brooklyn'..."
              className="flex-1 bg-black border border-white/20 rounded-full px-5 py-3 text-white placeholder-white/40 focus:outline-none focus:border-white/50 transition"
              disabled={isLoading}
            />
          </div>
        </form>
      </div>
    </div>
  );
}
