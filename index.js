// Complete Twilio + OpenAI Voice Agent Integration
const express = require('express');
const WebSocket = require('ws');
const app = express();
const port = process.env.PORT || 3000;

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
    console.error('❌ Missing OPENAI_API_KEY environment variable');
    process.exit(1);
}

// Create HTTP server
const server = require('http').createServer(app);

// Create WebSocket server with explicit path
const wss = new WebSocket.Server({ 
    server,
    path: '/media-stream'
});

app.get('/', (req, res) => {
    res.json({ 
        message: 'Twilio + OpenAI Voice Agent',
        websocket_url: `wss://${req.get('host')}/media-stream`,
        server_time: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        openai_configured: !!OPENAI_API_KEY,
        timestamp: new Date().toISOString() 
    });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('🔌 New WebSocket connection');
    
    let openaiWs = null;
    let streamSid = null;
    
    // Initialize OpenAI connection
    function initializeOpenAI() {
        console.log('🤖 Connecting to OpenAI Realtime API...');
        
        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });
        
        openaiWs.on('open', () => {
            console.log('✅ Connected to OpenAI Realtime API');
            
            // Configure the session
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: 'You are a helpful voice assistant. Keep responses brief and conversational. Speak naturally as if having a phone conversation.',
                    voice: 'alloy',
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    input_audio_transcription: {
                        model: 'whisper-1'
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500
                    }
                }
            };
            openaiWs.send(JSON.stringify(sessionUpdate));
        });
        
        openaiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                switch (response.type) {
                    case 'response.audio.delta':
                        // Send AI audio back to Twilio
                        if (streamSid && ws.readyState === WebSocket.OPEN) {
                            const mediaMessage = {
                                event: 'media',
                                streamSid: streamSid,
                                media: {
                                    payload: response.delta
                                }
                            };
                            ws.send(JSON.stringify(mediaMessage));
                        }
                        break;
                        
                    case 'response.audio_transcript.done':
                        console.log('🤖 AI said:', response.transcript);
                        break;
                        
                    case 'conversation.item.input_audio_transcription.completed':
                        console.log('👤 User said:', response.transcript);
                        break;
                        
                    case 'input_audio_buffer.speech_started':
                        console.log('👤 User started speaking');
                        break;
                        
                    case 'input_audio_buffer.speech_stopped':
                        console.log('👤 User stopped speaking');
                        break;
                        
                    case 'response.done':
                        console.log('✅ AI response complete');
                        break;
                        
                    case 'error':
                        console.error('❌ OpenAI error:', response.error);
                        break;
                        
                    case 'session.updated':
                        console.log('⚙️ OpenAI session configured');
                        break;
                }
            } catch (error) {
                console.error('❌ Error processing OpenAI message:', error);
            }
        });
        
        openaiWs.on('error', (error) => {
            console.error('❌ OpenAI WebSocket error:', error);
        });
        
        openaiWs.on('close', () => {
            console.log('🔌 OpenAI connection closed');
        });
    }
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'connected':
                    console.log('📞 Twilio connected');
                    break;
                    
                case 'start':
                    streamSid = data.start.streamSid;
                    console.log('🎙️ Stream started:', streamSid);
                    
                    // Initialize OpenAI when stream starts
                    initializeOpenAI();
                    break;
                    
                case 'media':
                    // Forward audio to OpenAI
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        const audioData = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        };
                        openaiWs.send(JSON.stringify(audioData));
                    }
                    break;
                    
                case 'stop':
                    console.log('🛑 Stream stopped');
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        openaiWs.close();
                    }
                    break;
            }
        } catch (error) {
            console.error('❌ Error processing Twilio message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('📞 Twilio connection closed');
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ Twilio WebSocket error:', error);
    });
});

wss.on('error', (error) => {
    console.error('❌ WebSocket Server error:', error);
});

server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📡 WebSocket ready for Twilio Media Streams`);
    console.log(`🤖 OpenAI Realtime API configured: ${!!OPENAI_API_KEY}`);
    console.log(`🌍 Server bound to all interfaces`);
});
