import { useState, useEffect, useRef } from 'react';

export default function Scout() {
  // Persist userId in localStorage so conversation context works across refreshes
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
  
  const messagesEndRef = useRef(null);
  
  const API_URL = '/api/chat';

  useEffect(() => {
    setMessages([{
      type: 'assistant',
      content: "Hey! I'm NYC Scout. Ask me about restaurants or events in NYC.\n\nTry: \"Best ramen in East Village\" or \"Comedy shows this weekend\""
    }]);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    
    const userMessage = input.trim();
    setInput('');
    setIsLoading(true);
    
    setMessages(prev => [...prev, { type: 'user', content: userMessage }]);
    
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage, userId })
      });
      
      const data = await res.json();
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      setMessages(prev => [...prev, {
        type: 'assistant',
        content: data.reply,
        category: data.category
      }]);
      
    } catch (err) {
      console.error('Chat error:', err);
      setMessages(prev => [...prev, {
        type: 'assistant',
        content: 'Something went wrong. Make sure the backend is running on port 3000.'
      }]);
    }
    
    setIsLoading(false);
  };

  const quickPrompts = [
    "Best pizza in Brooklyn",
    "Rooftop bars in Manhattan",
    "Live music tonight",
    "Comedy shows this weekend"
  ];

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
          <div className="text-xs text-white/40 border border-white/20 px-3 py-1 rounded">
            Test Mode
          </div>
        </div>
      </header>

      {/* Main Chat Area */}
      <main className="max-w-4xl mx-auto px-4 py-6 pb-32">
        {/* Quick Prompts */}
        {messages.length <= 1 && (
          <div className="mb-8">
            <p className="text-sm text-white/50 mb-3">Try asking:</p>
            <div className="flex flex-wrap gap-2">
              {quickPrompts.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => setInput(prompt)}
                  className="px-3 py-2 bg-black hover:bg-white/10 rounded border border-white/20 text-sm transition"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="space-y-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                  msg.type === 'user'
                    ? 'bg-white text-black'
                    : 'bg-white/10 text-white'
                }`}
              >
                {msg.category && (
                  <span className="inline-block text-xs border border-white/30 px-2 py-0.5 rounded mb-2">
                    {msg.category}
                  </span>
                )}
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
              placeholder="Ask about restaurants or events..."
              className="flex-1 bg-black border border-white/20 rounded-full px-5 py-3 text-white placeholder-white/40 focus:outline-none focus:border-white/50 transition"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="px-6 py-3 bg-white text-black rounded-full font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/90 transition"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}