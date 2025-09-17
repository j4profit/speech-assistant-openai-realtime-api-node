// Simple WebSocket test for Twilio Media Streams
const express = require('express');
const WebSocket = require('ws');
const app = express();
const port = process.env.PORT || 3000;

// Create HTTP server
const server = require('http').createServer(app);

// Create WebSocket server WITHOUT path restriction
const wss = new WebSocket.Server({ server });

app.get('/', (req, res) => {
    res.json({ 
        message: 'WebSocket server ready',
        websocket_url: `wss://${req.get('host')}/media-stream`,
        server_time: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        websocket_ready: true,
        timestamp: new Date().toISOString() 
    });
});

// Handle WebSocket upgrade manually
server.on('upgrade', (request, socket, head) => {
    console.log('🔄 WebSocket upgrade request to:', request.url);
    
    if (request.url === '/media-stream') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log('✅ WebSocket upgraded successfully');
            wss.emit('connection', ws, request);
        });
    } else {
        console.log('❌ Invalid WebSocket path:', request.url);
        socket.destroy();
    }
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('🔌 New WebSocket connection from:', req.connection.remoteAddress);
    console.log('🔗 Connection URL:', req.url);
    
    // Send a test message to confirm connection
    ws.send(JSON.stringify({
        event: 'connected',
        message: 'WebSocket connection established'
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Received event:', data.event || 'unknown');
            
            switch (data.event) {
                case 'connected':
                    console.log('✅ Twilio reports connected');
                    break;
                    
                case 'start':
                    console.log('🎙️ Stream started:', data.start?.streamSid);
                    break;
                    
                case 'media':
                    console.log('🔊 Audio data received, length:', data.media?.payload?.length || 'unknown');
                    // Just log the audio data, don't process it yet
                    break;
                    
                case 'stop':
                    console.log('🛑 Stream stopped');
                    break;
                    
                default:
                    console.log('❓ Unknown event:', data.event, Object.keys(data));
            }
        } catch (error) {
            console.error('❌ Error processing message:', error);
            console.log('📝 Raw message:', message.toString());
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`🔌 WebSocket connection closed. Code: ${code}, Reason: ${reason}`);
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
});

wss.on('error', (error) => {
    console.error('❌ WebSocket Server error:', error);
});

server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📡 WebSocket ready at wss://your-domain/media-stream`);
    console.log(`🌍 Server bound to all interfaces (0.0.0.0)`);
});
