"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { io } from "socket.io-client";
import Link from "next/link";
import PointerLockStatus from "../components/PointerLockStatus";

export default function ViewerContent() {
  // Current state and refs
  const searchParams = useSearchParams();
  const connectionId = searchParams.get("id");
  const [status, setStatus] = useState("initializing");
  const [errorMessage, setErrorMessage] = useState("");
  const [debugLog, setDebugLog] = useState([]);

  // References
  const remoteVideoRef = useRef(null);
  const containerRef = useRef(null);
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);

  // Store event handler references
  const eventHandlersRef = useRef({
    mouseMoveHandler: null,
    mouseDownHandler: null,
    mouseUpHandler: null,
    keyDownHandler: null,
    keyUpHandler: null
  });

  // Add debug logging with useCallback
  const addDebugLog = useCallback((message) => {
    console.log(`[VIEWER] ${message}`);
    setDebugLog(prev => [...prev.slice(-9), {
      time: new Date().toLocaleTimeString(),
      message
    }]);
  }, []);

  // The main WebRTC connection setup
  useEffect(() => {
    if (!connectionId) return;

    addDebugLog(`Initializing viewer for connection ID: ${connectionId}`);

    // Connect to signaling server
    try {
      const socketURL = process.env.NEXT_PUBLIC_SOCKET_URL || "https://remote-desktop-backend.onrender.com";
      addDebugLog(`Connecting to socket server at: ${socketURL}`);

      socketRef.current = io(socketURL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        timeout: 10000
      });
    } catch (err) {
      addDebugLog(`Error creating socket: ${err.message}`);
      setStatus("error");
      setErrorMessage(`Socket creation error: ${err.message}`);
      return;
    }

    // Socket connection listeners
    socketRef.current.on('connect', () => {
      addDebugLog('Socket connected! Socket ID: ' + socketRef.current.id);
      // After successful socket connection, join the room
      socketRef.current.emit("join-room", { roomId: connectionId, isHost: false });
      setStatus("connecting");
    });

    socketRef.current.on('connect_error', (err) => {
      addDebugLog(`Socket connection error: ${err.message}`);
      setStatus("error");
      setErrorMessage(`Socket connection error: ${err.message}`);
    });

    // Setup WebRTC
    const setupWebRTC = async () => {
      try {
        addDebugLog('Setting up WebRTC...');
        // Create RTCPeerConnection with STUN/TURN servers
        const configuration = {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" }
          ],
          iceCandidatePoolSize: 10
        };

        peerConnectionRef.current = new RTCPeerConnection(configuration);
        addDebugLog('RTCPeerConnection created');

        // Set up event handlers for incoming tracks
        peerConnectionRef.current.ontrack = (event) => {
          addDebugLog(`Track received: ${event.track.kind}`);
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
        };

        // Handle ICE candidates
        peerConnectionRef.current.onicecandidate = (event) => {
          if (event.candidate) {
            addDebugLog('ICE candidate generated');
            socketRef.current.emit("ice-candidate", {
              roomId: connectionId,
              candidate: event.candidate
            });
          }
        };

        // Log ICE connection state changes
        peerConnectionRef.current.oniceconnectionstatechange = () => {
          const state = peerConnectionRef.current.iceConnectionState;
          addDebugLog(`ICE connection state: ${state}`);

          if (state === 'connected' || state === 'completed') {
            setStatus("connected");
          } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
            if (state === 'failed') {
              setStatus("connection-failed");
              setErrorMessage(`ICE connection failed: ${state}`);
            }
          }
        };

        // Connection state handling
        peerConnectionRef.current.onconnectionstatechange = () => {
          const state = peerConnectionRef.current.connectionState;
          addDebugLog(`Connection state: ${state}`);

          if (state === 'connected') {
            setStatus("connected");
          } else if (state === 'failed' || state === 'closed') {
            if (state === 'failed') {
              setStatus("connection-failed");
            }
          }
        };
      } catch (err) {
        addDebugLog(`Error setting up WebRTC: ${err.message}`);
        setStatus("error");
        setErrorMessage(`WebRTC setup error: ${err.message}`);
      }
    };

    // Call setupWebRTC
    setupWebRTC();

    // Antes de registrar, limpia listeners previos (evita duplicados si el useEffect corre dos veces)
    socketRef.current.off("offer");
    socketRef.current.off("ice-candidate");

    // UN SOLO listener de offer
    socketRef.current.on("offer", async (data) => {
      addDebugLog('Received offer from host');
      try {
        if (!peerConnectionRef.current) {
          addDebugLog("PeerConnection not initialized when offer received");
          return;
        }
        // Guarda doble: estado y remoteDescription
        if (peerConnectionRef.current.signalingState !== "stable" ||
          peerConnectionRef.current.remoteDescription) {
          addDebugLog(`Ignoring duplicate offer. State: ${peerConnectionRef.current.signalingState}`);
          return;
        }

        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.offer));
        addDebugLog('Remote description set successfully');

        const answer = await peerConnectionRef.current.createAnswer();
        addDebugLog('Answer created');

        await peerConnectionRef.current.setLocalDescription(answer);
        addDebugLog('Local description set');

        socketRef.current.emit("answer", {
          roomId: connectionId,
          answer: answer
        });
        addDebugLog('Answer sent to host');
        setStatus("awaiting-connection");
      } catch (err) {
        addDebugLog(`Error handling offer: ${err.message}`);
        setStatus("error");
        setErrorMessage(`Error handling offer: ${err.message}`);
      }
    });

    // UN SOLO listener de ice-candidate
    socketRef.current.on("ice-candidate", async (data) => {
      try {
        addDebugLog('Received ICE candidate from host');
        if (peerConnectionRef.current) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
          addDebugLog('Added ICE candidate from host');
        }
      } catch (e) {
        addDebugLog(`Error adding ICE candidate: ${e.message}`);
      }
    });

    // Handle host disconnect
    socketRef.current.on("host-disconnected", () => {
      addDebugLog('Host disconnected');
      setStatus("host-disconnected");
    });

    // Handle when no host is found in the room
    socketRef.current.on("no-host-in-room", () => {
      addDebugLog('No host found in this room');
      setStatus("no-host");
      setErrorMessage("No host found with this connection ID. Please check the ID and try again.");
    });

    // Cleanup on unmount
    return () => {
      // Make sure control is disabled when component unmounts
      // Close WebRTC and WebSocket connections
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
      if (socketRef.current) {
        socketRef.current.off("offer");
        socketRef.current.off("ice-candidate");
        socketRef.current.off("answer");
        socketRef.current.off("host-disconnected");
        socketRef.current.off("no-host-in-room");
        socketRef.current.disconnect();
      }
      addDebugLog('Cleaning up viewer connection');
    };
  }, [connectionId, addDebugLog]);

  return (
    <>
      <PointerLockStatus />
      <div className="flex flex-col items-center min-h-screen p-4">
        <header className="w-full max-w-5xl flex justify-between items-center mb-6">
          <Link href="/" className="text-blue-500 hover:underline">← Back to Dashboard</Link>
          <div className="flex items-center gap-2">
            <div className={`h-3 w-3 rounded-full ${status === "connected" ? 'bg-green-500' :
              status === "error" || status === "connection-failed" || status === "no-host" ? 'bg-red-500' : 'bg-yellow-500'
              }`}></div>
            <span>Status: {status}</span>
          </div>
        </header>

        <div className="flex flex-col items-center w-full max-w-5xl">
          <div className="bg-gray-100 dark:bg-gray-800 p-6 rounded-lg shadow-md mb-6 w-full">
            <h1 className="text-2xl font-bold mb-4">Viewing Remote Screen</h1>
            <div className="mb-4">
              <p className="font-semibold">Connection ID:</p>
              <span className="font-mono bg-gray-200 dark:bg-gray-700 py-1 px-2 rounded">
                {connectionId || "N/A"}
              </span>
            </div>
            {errorMessage && (
              <div className="text-red-500 mb-4 p-2 bg-red-100 dark:bg-red-900/20 rounded">
                {errorMessage}
              </div>
            )}
          </div>

          <div
            ref={containerRef}
            className="relative w-full aspect-video bg-black rounded-lg overflow-hidden cursor-crosshair"
          >
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-contain"
            />
            {status !== "connected" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70 text-white">
                {status === "initializing" && "Initializing..."}
                {status === "connecting" && "Connecting to signaling server..."}
                {status === "awaiting-connection" && "Establishing WebRTC connection..."}
                {status === "error" && "Connection error!"}
                {status === "no-host" && "No host found with this ID"}
                {status === "host-disconnected" && "Host has disconnected"}
                {status === "connection-failed" && "Connection failed"}
              </div>
            )}
          </div>

          {/* Debug Log */}
          {debugLog.length > 0 && (
            <div className="w-full bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mt-4">
              <h3 className="font-semibold mb-2">Debug Log:</h3>
              <div className="max-h-32 overflow-y-auto text-xs font-mono">
                {debugLog.map((item, index) => (
                  <div key={index} className="mb-1">
                    <span className="text-gray-500">[{item.time}]</span> {item.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
