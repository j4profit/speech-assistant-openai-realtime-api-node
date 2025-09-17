// Twilio + OpenAI Voice Agent Integration
// This example uses Node.js, Express, and WebSockets

const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Middleware for parsing request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Add request logging for debugging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Twilio webhook for incoming calls
app.post('/voice', (req, res) => {
    console.log('Received call webhook:', req.body);
    const twiml = new twilio.twiml.VoiceResponse();
    
    // Connect to WebSocket for real-time audio streaming
    const connect = twiml.connect();
    connect.stream({
        url: `wss://${req.headers.host}/media-stream`,
        track: 'both_tracks' // Send both caller and receiver audio
    });
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// WebSocket server for handling Twilio Media Streams
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    
    let openaiWs = null;
    let streamSid = null;
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'connected':
                    console.log('Twilio connected');
                    break;
                    
                case 'start':
                    streamSid = data.start.streamSid;
                    console.log(`Stream started: ${streamSid}`);
                    
                    // Initialize OpenAI Realtime API connection
                    await initializeOpenAIConnection(ws);
                    break;
                    
                case 'media':
                    // Forward audio to OpenAI
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        const audioData = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload // Base64 encoded audio
                        };
                        openaiWs.send(JSON.stringify(audioData));
                    }
                    break;
                    
                case 'stop':
                    console.log('Stream stopped');
                    if (openaiWs) {
                        openaiWs.close();
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
    
    async function initializeOpenAIConnection(twilioWs) {
        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });
        
        openaiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            
            // Configure the session
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: 'You are a helpful voice assistant. Respond naturally and conversationally.',
                    voice: 'alloy',
                    input_audio_format: 'mulaw',
                    output_audio_format: 'mulaw',
                    input_audio_transcription: {
                        model: 'whisper-1'
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 200
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
                        // Send audio back to Twilio
                        const mediaMessage = {
                            event: 'media',
                            streamSid: streamSid,
                            media: {
                                payload: response.delta
                            }
                        };
                        twilioWs.send(JSON.stringify(mediaMessage));
                        break;
                        
                    case 'response.text.done':
                        console.log('Assistant response:', response.text);
                        break;
                        
                    case 'input_audio_buffer.speech_started':
                        console.log('User started speaking');
                        break;
                        
                    case 'input_audio_buffer.speech_stopped':
                        console.log('User stopped speaking');
                        break;
                        
                    case 'error':
                        console.error('OpenAI error:', response.error);
                        break;
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });
        
        openaiWs.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
        });
        
        openaiWs.on('close', () => {
            console.log('OpenAI connection closed');
        });
    }
    
    ws.on('close', () => {
        console.log('Twilio WebSocket connection closed');
        if (openaiWs) {
            openaiWs.close();
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Test endpoint to verify server is working
app.get('/', (req, res) => {
    res.json({ 
        message: 'Twilio + OpenAI Voice Agent Server', 
        status: 'running',
        endpoints: {
            voice: 'POST /voice',
            health: 'GET /health'
        }
    });
});

// Add error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

/* 
SETUP INSTRUCTIONS:

1. Install dependencies:
   npm init -y
   npm install express ws twilio openai

2. Set environment variables:
   export TWILIO_ACCOUNT_SID="your_account_sid"
   export TWILIO_AUTH_TOKEN="your_auth_token"
   export OPENAI_API_KEY="your_openai_api_key"

3. Deploy to a server with public URL (like Heroku, Railway, or ngrok for testing)

4. Configure Twilio phone number:
   - Go to Twilio Console > Phone Numbers
   - Select your phone number
   - Set webhook URL to: https://your-domain.com/voice
   - Set HTTP method to POST

5. Test by calling your Twilio phone number

ADDITIONAL FEATURES TO CONSIDER:

- Add conversation logging
- Implement call recording
- Add custom voice prompts
- Handle call transfers
- Add conversation analytics
- Implement user authentication
- Add multi-language support
*/
