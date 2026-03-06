import type { Server as HTTPServer } from "http";
import type { NextApiRequest, NextApiResponse } from "next";
import type { Socket as NetSocket } from "net";
import { verifyToken } from "@clerk/nextjs/server";
import { Server as IOServer, type Socket } from "socket.io";

import {
  analyzeTranscriptTurn,
  ensureMeetingAiInsights,
  ensureMeetingAiSession,
  loadMeetingAiSuggestions,
  persistTranscriptTurn,
} from "@/lib/meeting-ai";
import { completeMeetingRoom } from "@/lib/meeting-lifecycle";
import { prisma } from "@/lib/prisma";
import { resolveMeetingAccess } from "@/lib/meetingAccess";

type SocketServer = HTTPServer & {
  io?: IOServer;
};

type SocketWithIO = NetSocket & {
  server: SocketServer;
};

type NextApiResponseWithSocket = NextApiResponse & {
  socket: SocketWithIO;
};

type PresenceParticipant = {
  socketId: string;
  userId: string;
  name: string;
  role: "CANDIDATE" | "INTERVIEWER";
  isScreenSharing: boolean;
  screenTrackId?: string | null;
};

type QueuedAiTurn = {
  meetingAiSessionId: string;
  relatedToTurnId: string;
  lastTurn: {
    speaker: "CANDIDATE" | "INTERVIEWER";
    text: string;
    timestamp: string;
  };
};

type AiRuntimeState = {
  processing: boolean;
  timer: NodeJS.Timeout | null;
  pending: QueuedAiTurn | null;
};

type AiRoomSettings = {
  liveTranscribeEnabled: boolean;
  dynamicQuestionsEnabled: boolean;
};

type SocketContext = {
  clerkUserId: string;
  meetingToken: string;
  meetingRoomId: string;
  roundId: string;
  slotId: string;
  userId: string;
  userName: string;
  userRole: "CANDIDATE" | "INTERVIEWER";
  isOwner: boolean;
  canMarkCompleted: boolean;
  participantRecordId: string | null;
  aiSessionId: string | null;
};

type TranscriptPayload = {
  meetingRoomId?: string;
  speaker: "CANDIDATE" | "INTERVIEWER";
  text: string;
  timestamp?: string;
  speakerName?: string;
  segmentId?: string;
  isFinal?: boolean;
};

type AiSettingsUpdatePayload = {
  liveTranscribeEnabled?: boolean;
  dynamicQuestionsEnabled?: boolean;
};

const globalForSocket = globalThis as unknown as {
  meetingPresence?: Map<string, Map<string, PresenceParticipant>>;
  aiRuntimeByRoom?: Map<string, AiRuntimeState>;
  aiSettingsByRoom?: Map<string, AiRoomSettings>;
};

const meetingPresence =
  globalForSocket.meetingPresence ?? new Map<string, Map<string, PresenceParticipant>>();

const aiRuntimeByRoom = globalForSocket.aiRuntimeByRoom ?? new Map<string, AiRuntimeState>();
const aiSettingsByRoom = globalForSocket.aiSettingsByRoom ?? new Map<string, AiRoomSettings>();

if (!globalForSocket.meetingPresence) {
  globalForSocket.meetingPresence = meetingPresence;
}

if (!globalForSocket.aiRuntimeByRoom) {
  globalForSocket.aiRuntimeByRoom = aiRuntimeByRoom;
}

if (!globalForSocket.aiSettingsByRoom) {
  globalForSocket.aiSettingsByRoom = aiSettingsByRoom;
}

const DEBUG_TRANSCRIPTION =
  process.env.DEBUG_TRANSCRIPTION === "1" ||
  process.env.NEXT_PUBLIC_DEBUG_TRANSCRIPTION === "1";

function logTranscript(...args: unknown[]) {
  if (!DEBUG_TRANSCRIPTION) {
    return;
  }
  console.log("[socket/transcription]", ...args);
}

function getPresenceForRoom(meetingRoomId: string) {
  let roomPresence = meetingPresence.get(meetingRoomId);
  if (!roomPresence) {
    roomPresence = new Map<string, PresenceParticipant>();
    meetingPresence.set(meetingRoomId, roomPresence);
  }
  return roomPresence;
}

function toPublicPresenceList(roomPresence: Map<string, PresenceParticipant>) {
  return Array.from(roomPresence.values());
}

function getAiRuntimeState(meetingRoomId: string) {
  let state = aiRuntimeByRoom.get(meetingRoomId);
  if (!state) {
    state = {
      processing: false,
      timer: null,
      pending: null,
    };
    aiRuntimeByRoom.set(meetingRoomId, state);
  }
  return state;
}

function getAiRoomSettings(meetingRoomId: string) {
  let settings = aiSettingsByRoom.get(meetingRoomId);
  if (!settings) {
    settings = {
      liveTranscribeEnabled: true,
      dynamicQuestionsEnabled: true,
    };
    aiSettingsByRoom.set(meetingRoomId, settings);
  }
  return settings;
}

function clearAiRuntimeIfUnused(meetingRoomId: string) {
  const presence = meetingPresence.get(meetingRoomId);
  if (presence && presence.size > 0) {
    return;
  }

  const state = aiRuntimeByRoom.get(meetingRoomId);
  if (state?.timer) {
    clearTimeout(state.timer);
  }
  aiRuntimeByRoom.delete(meetingRoomId);
  aiSettingsByRoom.delete(meetingRoomId);
}

function emitToInterviewers(
  io: IOServer,
  meetingRoomId: string,
  event: string,
  payload: unknown,
) {
  const roomPresence = getPresenceForRoom(meetingRoomId);
  for (const participant of roomPresence.values()) {
    if (participant.role !== "INTERVIEWER") {
      continue;
    }
    io.to(participant.socketId).emit(event, payload);
  }
}

async function markParticipantLeft(participantRecordId: string | null) {
  if (!participantRecordId) {
    return;
  }

  await prisma.meetingParticipant.updateMany({
    where: {
      id: participantRecordId,
      leftAt: null,
    },
    data: {
      leftAt: new Date(),
    },
  });
}

function normalizeTimestamp(rawTimestamp?: string) {
  if (!rawTimestamp) {
    return new Date();
  }

  const parsed = new Date(rawTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function scheduleAiAnalysis(
  io: IOServer,
  meetingRoomId: string,
  queuedTurn: QueuedAiTurn,
) {
  const state = getAiRuntimeState(meetingRoomId);
  state.pending = queuedTurn;

  if (state.timer) {
    return;
  }

  state.timer = setTimeout(() => {
    void flushAiAnalysis(io, meetingRoomId);
  }, 1200);
}

async function flushAiAnalysis(io: IOServer, meetingRoomId: string) {
  const state = getAiRuntimeState(meetingRoomId);
  const settings = getAiRoomSettings(meetingRoomId);

  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  if (state.processing || !state.pending) {
    return;
  }

  const pendingTurn = state.pending;
  state.pending = null;
  state.processing = true;

  try {
    if (!settings.dynamicQuestionsEnabled) {
      return;
    }

    const suggestions = await analyzeTranscriptTurn({
      meetingRoomId,
      meetingAiSessionId: pendingTurn.meetingAiSessionId,
      relatedToTurnId: pendingTurn.relatedToTurnId,
      lastTurn: pendingTurn.lastTurn,
    });

    for (const suggestion of suggestions) {
      emitToInterviewers(io, meetingRoomId, "ai:suggestion", suggestion);
    }
  } catch (error) {
    emitToInterviewers(io, meetingRoomId, "ai:error", {
      message: error instanceof Error ? error.message : "AI analysis failed",
    });
  } finally {
    state.processing = false;
    if (state.pending) {
      scheduleAiAnalysis(io, meetingRoomId, state.pending);
    }
  }
}

function registerSocketServer(io: IOServer) {
  io.use(async (socket, next) => {
    try {
      const sessionToken =
        typeof socket.handshake.auth?.sessionToken === "string"
          ? socket.handshake.auth.sessionToken
          : "";
      const meetingToken =
        typeof socket.handshake.auth?.meetingToken === "string"
          ? socket.handshake.auth.meetingToken
          : "";

      if (!sessionToken || !meetingToken) {
        next(new Error("Missing authentication context"));
        return;
      }

      const verified = await verifyToken(sessionToken, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });

      if (!verified || !verified.sub) {
        next(new Error("Invalid session token"));
        return;
      }

      const access = await resolveMeetingAccess(meetingToken, verified.sub);

      if (!access.ok) {
        next(new Error(access.message));
        return;
      }

      if (access.viewerRole === "CANDIDATE") {
        const parsedResume = await prisma.parsedResume.findUnique({
          where: {
            candidateUserId_roundId: {
              candidateUserId: access.user.id,
              roundId: access.room.roundId,
            },
          },
          select: { id: true },
        });

        if (!parsedResume) {
          next(new Error("Upload your resume before joining this interview"));
          return;
        }
      }

      if (!access.canJoin) {
        if (access.joinBlockedReason === "MEETING_ENDED") {
          next(new Error("Meeting is no longer joinable"));
          return;
        }
      }

      const context: SocketContext = {
        clerkUserId: access.user.clerkUserId,
        meetingToken,
        meetingRoomId: access.room.id,
        roundId: access.room.roundId,
        slotId: access.room.slotId,
        userId: access.user.id,
        userName:
          access.user.name ??
          access.user.email ??
          (access.viewerRole === "INTERVIEWER" ? "Interviewer" : "Candidate"),
        userRole: access.user.role,
        isOwner: access.isOwner,
        canMarkCompleted: access.canMarkCompleted,
        participantRecordId: null,
        aiSessionId: null,
      };

      socket.data.context = context;
      next();
    } catch (error) {
      next(new Error(error instanceof Error ? error.message : "Unable to connect"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const context = socket.data.context as SocketContext | undefined;

    if (!context) {
      socket.disconnect();
      return;
    }

    let joined = false;

    socket.on("join-room", async () => {
      if (joined) {
        return;
      }

      joined = true;

      const meetingRoomId = context.meetingRoomId;
      const roomPresence = getPresenceForRoom(meetingRoomId);
      const existingParticipants = toPublicPresenceList(roomPresence);

      socket.join(meetingRoomId);

      const participantRecord = await prisma.meetingParticipant.create({
        data: {
          meetingRoomId,
          userId: context.userId,
          role: context.userRole,
        },
        select: {
          id: true,
        },
      });

      context.participantRecordId = participantRecord.id;

      const participant: PresenceParticipant = {
        socketId: socket.id,
        userId: context.userId,
        name: context.userName,
        role: context.userRole,
        isScreenSharing: false,
        screenTrackId: null,
      };

      roomPresence.set(socket.id, participant);

      socket.emit("room-state", {
        participants: existingParticipants,
      });

      socket.emit("ai:public-settings", getAiRoomSettings(meetingRoomId));
      const aiSession = await ensureMeetingAiSession(meetingRoomId);
      socket.emit("ai:public-toggle", { aiEnabled: aiSession.aiEnabled });

      socket.to(meetingRoomId).emit("participant-joined", participant);
      io.to(meetingRoomId).emit("presence-updated", {
        participants: toPublicPresenceList(roomPresence),
      });
    });

    socket.on(
      "offer",
      ({ targetSocketId, sdp }: { targetSocketId: string; sdp: RTCSessionDescriptionInit }) => {
        socket.to(targetSocketId).emit("offer", {
          senderSocketId: socket.id,
          sdp,
        });
      },
    );

    socket.on(
      "answer",
      ({ targetSocketId, sdp }: { targetSocketId: string; sdp: RTCSessionDescriptionInit }) => {
        socket.to(targetSocketId).emit("answer", {
          senderSocketId: socket.id,
          sdp,
        });
      },
    );

    socket.on(
      "ice-candidate",
      ({
        targetSocketId,
        candidate,
      }: {
        targetSocketId: string;
        candidate: RTCIceCandidateInit;
      }) => {
        socket.to(targetSocketId).emit("ice-candidate", {
          senderSocketId: socket.id,
          candidate,
        });
      },
    );

    socket.on(
      "screen-share-state",
      ({
        isScreenSharing,
        trackId,
      }: {
        isScreenSharing: boolean;
        trackId?: string | null;
      }) => {
      const roomPresence = getPresenceForRoom(context.meetingRoomId);
      const existing = roomPresence.get(socket.id);

      if (!existing) {
        return;
      }

      roomPresence.set(socket.id, {
        ...existing,
        isScreenSharing: Boolean(isScreenSharing),
        screenTrackId: isScreenSharing ? (trackId ?? existing.screenTrackId ?? null) : null,
      });

      io.to(context.meetingRoomId).emit("presence-updated", {
        participants: toPublicPresenceList(roomPresence),
      });
      },
    );

    socket.on("chat-message", async ({ message }: { message: string }) => {
      const trimmed = message.trim();
      if (!trimmed) {
        return;
      }

      const created = await prisma.meetingChatMessage.create({
        data: {
          meetingRoomId: context.meetingRoomId,
          senderUserId: context.userId,
          message: trimmed.slice(0, 2000),
        },
        select: {
          id: true,
          message: true,
          createdAt: true,
        },
      });

      io.to(context.meetingRoomId).emit("chat-message", {
        id: created.id,
        message: created.message,
        createdAt: created.createdAt.toISOString(),
        senderUserId: context.userId,
        senderName: context.userName,
        senderRole: context.userRole,
      });
    });

    socket.on("ai:subscribe", async () => {
      if (context.userRole !== "INTERVIEWER") {
        socket.emit("ai:error", { message: "Only interviewers can use AI copilot" });
        return;
      }

      try {
        const insights = await ensureMeetingAiInsights(context.meetingRoomId);
        context.aiSessionId = insights.sessionId;
        const suggestions = await loadMeetingAiSuggestions(insights.sessionId);
        const settings = getAiRoomSettings(context.meetingRoomId);

        socket.emit("ai:state", {
          aiEnabled: insights.aiEnabled,
          provider: insights.provider,
          summary: insights.summary.bullets,
          questionSuggestions: insights.questions.questions,
          suggestions,
          settings,
        });

        socket.emit("ai:resume_summary", {
          bullets: insights.summary.bullets,
        });

        socket.emit("ai:question_suggestions", {
          questions: insights.questions.questions,
        });
      } catch (error) {
        socket.emit("ai:error", {
          message: error instanceof Error ? error.message : "Unable to initialize AI",
        });
      }
    });

    socket.on("ai:settings:update", (payload: AiSettingsUpdatePayload) => {
      if (context.userRole !== "INTERVIEWER") {
        socket.emit("ai:error", { message: "Only interviewers can change AI settings" });
        return;
      }

      const settings = getAiRoomSettings(context.meetingRoomId);
      const nextSettings: AiRoomSettings = {
        liveTranscribeEnabled:
          typeof payload.liveTranscribeEnabled === "boolean"
            ? payload.liveTranscribeEnabled
            : settings.liveTranscribeEnabled,
        dynamicQuestionsEnabled:
          typeof payload.dynamicQuestionsEnabled === "boolean"
            ? payload.dynamicQuestionsEnabled
            : settings.dynamicQuestionsEnabled,
      };

      aiSettingsByRoom.set(context.meetingRoomId, nextSettings);

      if (!nextSettings.dynamicQuestionsEnabled || !nextSettings.liveTranscribeEnabled) {
        const runtime = getAiRuntimeState(context.meetingRoomId);
        runtime.pending = null;
      }

      emitToInterviewers(io, context.meetingRoomId, "ai:settings", nextSettings);
      io.to(context.meetingRoomId).emit("ai:public-settings", nextSettings);
    });

    socket.on("ai:toggle", async ({ aiEnabled }: { aiEnabled: boolean }) => {
      if (context.userRole !== "INTERVIEWER") {
        socket.emit("ai:error", { message: "Only interviewers can toggle AI" });
        return;
      }

      if (!context.isOwner) {
        socket.emit("ai:error", { message: "Only the owner can toggle AI" });
        return;
      }

      const session = await ensureMeetingAiSession(context.meetingRoomId);
      context.aiSessionId = session.id;

      await prisma.meetingAiSession.update({
        where: { id: session.id },
        data: {
          aiEnabled: Boolean(aiEnabled),
        },
      });

      const runtime = getAiRuntimeState(context.meetingRoomId);
      if (!aiEnabled) {
        runtime.pending = null;
      }

      emitToInterviewers(io, context.meetingRoomId, "ai:toggle", {
        aiEnabled: Boolean(aiEnabled),
      });

      io.to(context.meetingRoomId).emit("ai:public-toggle", {
        aiEnabled: Boolean(aiEnabled),
      });
    });

    socket.on("ai:transcript", async (payload: TranscriptPayload) => {
      const text = payload.text?.trim();
      if (!text) {
        return;
      }

      logTranscript("inbound", {
        roomId: context.meetingRoomId,
        speaker: payload.speaker,
        isFinal: payload.isFinal !== false,
        textPreview: text.slice(0, 80),
        segmentId: payload.segmentId ?? null,
      });

      if (payload.meetingRoomId && payload.meetingRoomId !== context.meetingRoomId) {
        socket.emit("ai:error", { message: "Meeting context mismatch" });
        return;
      }

      if (
        context.userRole === "CANDIDATE" &&
        payload.speaker !== "CANDIDATE"
      ) {
        socket.emit("ai:error", { message: "Invalid speaker label" });
        return;
      }

      if (
        context.userRole === "INTERVIEWER" &&
        payload.speaker !== "INTERVIEWER" &&
        payload.speaker !== "CANDIDATE"
      ) {
        socket.emit("ai:error", { message: "Invalid speaker label" });
        return;
      }

      try {
        const settings = getAiRoomSettings(context.meetingRoomId);
        if (!settings.liveTranscribeEnabled) {
          return;
        }

        const roleBasedName =
          payload.speaker === "INTERVIEWER"
            ? context.userName
            : context.userRole === "CANDIDATE"
              ? context.userName
              : "Candidate";
        const speakerName = payload.speakerName?.trim().slice(0, 120) || roleBasedName;
        const timestamp = normalizeTimestamp(payload.timestamp);
        const isFinal = payload.isFinal !== false;

        if (!isFinal) {
          io.to(context.meetingRoomId).emit("transcript:interim", {
            speakerRole: payload.speaker,
            speakerName,
            text: text.slice(0, 800),
            timestamp: timestamp.toISOString(),
            segmentId: payload.segmentId ?? null,
          });
          logTranscript("broadcast interim", {
            roomId: context.meetingRoomId,
            speaker: payload.speaker,
            textPreview: text.slice(0, 80),
          });
          return;
        }

        const session = context.aiSessionId
          ? await prisma.meetingAiSession.findUnique({
              where: { id: context.aiSessionId },
              select: { id: true, aiEnabled: true },
            })
          : null;

        const activeSession = session ?? (await ensureMeetingAiSession(context.meetingRoomId));
        context.aiSessionId = activeSession.id;

        if (!activeSession.aiEnabled) {
          return;
        }

        const turn = await persistTranscriptTurn({
          meetingAiSessionId: activeSession.id,
          speaker: payload.speaker,
          speakerUserId: context.userId,
          text: text.slice(0, 1200),
          timestamp,
        });

        io.to(context.meetingRoomId).emit("transcript:append", {
          id: turn.id,
          speakerRole: turn.speaker,
          speakerName,
          text: turn.text,
          timestamp: turn.timestamp.toISOString(),
          segmentId: payload.segmentId ?? null,
        });
        logTranscript("broadcast final", {
          roomId: context.meetingRoomId,
          speaker: turn.speaker,
          dbId: turn.id,
          textPreview: turn.text.slice(0, 80),
        });

        emitToInterviewers(io, context.meetingRoomId, "ai:transcript:turn", {
          speaker: turn.speaker,
          speakerName,
          text: turn.text,
          timestamp: turn.timestamp.toISOString(),
        });

        if (!settings.dynamicQuestionsEnabled || turn.speaker !== "CANDIDATE") {
          return;
        }

        scheduleAiAnalysis(io, context.meetingRoomId, {
          meetingAiSessionId: activeSession.id,
          relatedToTurnId: turn.id,
          lastTurn: {
            speaker: turn.speaker,
            text: turn.text,
            timestamp: turn.timestamp.toISOString(),
          },
        });
      } catch (error) {
        socket.emit("ai:error", {
          message:
            error instanceof Error
              ? error.message
              : "Unable to process transcript",
        });
      }
    });

    socket.on("end-meeting", async () => {
      if (!context.canMarkCompleted) {
        socket.emit("meeting-error", {
          message: "You do not have permission to mark this meeting as completed",
        });
        return;
      }

      const completionResult = await completeMeetingRoom({
        meetingRoomId: context.meetingRoomId,
        clerkUserId: context.clerkUserId,
      });

      if (!completionResult.ok) {
        socket.emit("meeting-error", {
          message: completionResult.message,
        });
        return;
      }

      io.to(context.meetingRoomId).emit("meeting-ended", {
        endedAt: completionResult.completedAt,
      });

      meetingPresence.delete(context.meetingRoomId);
      clearAiRuntimeIfUnused(context.meetingRoomId);
    });

    socket.on("leave-room", async () => {
      const roomPresence = getPresenceForRoom(context.meetingRoomId);
      roomPresence.delete(socket.id);

      await markParticipantLeft(context.participantRecordId);
      context.participantRecordId = null;

      socket.to(context.meetingRoomId).emit("participant-left", {
        socketId: socket.id,
      });
      io.to(context.meetingRoomId).emit("presence-updated", {
        participants: toPublicPresenceList(roomPresence),
      });

      if (roomPresence.size === 0) {
        meetingPresence.delete(context.meetingRoomId);
        clearAiRuntimeIfUnused(context.meetingRoomId);
      }
    });

    socket.on("disconnect", async () => {
      const roomPresence = getPresenceForRoom(context.meetingRoomId);
      roomPresence.delete(socket.id);

      await markParticipantLeft(context.participantRecordId);
      context.participantRecordId = null;

      socket.to(context.meetingRoomId).emit("participant-left", {
        socketId: socket.id,
      });
      io.to(context.meetingRoomId).emit("presence-updated", {
        participants: toPublicPresenceList(roomPresence),
      });

      if (roomPresence.size === 0) {
        meetingPresence.delete(context.meetingRoomId);
        clearAiRuntimeIfUnused(context.meetingRoomId);
      }
    });
  });
}

export default function handler(_req: NextApiRequest, res: NextApiResponseWithSocket) {
  if (!res.socket.server.io) {
    const io = new IOServer(res.socket.server, {
      path: "/api/socket_io",
      addTrailingSlash: false,
      cors: {
        origin: "*",
      },
    });

    res.socket.server.io = io;
    registerSocketServer(io);
  }

  res.status(200).json({ ok: true });
}
