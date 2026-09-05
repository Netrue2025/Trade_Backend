const crypto = require("node:crypto");

const { randomId } = require("../lib/security");

const QUEST_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const QUEST_CATEGORIES = ["technology", "AI", "IoT", "agriculture", "animals", "plants", "crypto"];
const ACTIVE_SESSION_STATUSES = ["STARTED", "IN_PROGRESS", "COMPLETED", "REWARD_ASSIGNED", "REVEALED"];
const AVAILABLE_REWARD_STATUSES = ["UNUSED"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeCategory(value) {
  const raw = normalizeText(value);
  const match = QUEST_CATEGORIES.find((category) => category.toLowerCase() === raw.toLowerCase());
  if (!match) {
    throw new Error("Choose a valid quest category.");
  }
  return match;
}

function normalizeStageType(value) {
  const type = normalizeText(value || "multiple-choice").toLowerCase();
  if (!["multiple-choice", "true-false", "matching", "sequence"].includes(type)) {
    throw new Error("Choose a valid stage type.");
  }
  return type;
}

function normalizeAnswer(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item).toLowerCase());
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((memo, key) => {
        memo[normalizeText(key).toLowerCase()] = normalizeText(value[key]).toLowerCase();
        return memo;
      }, {});
  }
  return normalizeText(value).toLowerCase();
}

function answersMatch(expected, received) {
  const normalizedExpected = normalizeAnswer(expected);
  const normalizedReceived = normalizeAnswer(received);
  return JSON.stringify(normalizedExpected) === JSON.stringify(normalizedReceived);
}

function parseDateMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function createDefaultQuest(clock, idGenerator) {
  const now = clock();
  return {
    id: idGenerator(12),
    title: "Netrue Market Quest",
    category: "crypto",
    difficulty: "easy",
    description: "A quick money-smart challenge for active members.",
    active: true,
    manuallyDisabled: false,
    autoDisabledReason: "",
    startsAt: null,
    endsAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: "system",
    deletedAt: null,
    stats: {
      started: 0,
      completed: 0,
      rewarded: 0,
      redeemed: 0,
    },
    stages: [
      {
        id: idGenerator(12),
        type: "multiple-choice",
        prompt: "What does P&L show?",
        options: ["Profit and loss", "Password and login", "Payment limit", "Pending ledger"],
        correctAnswer: "Profit and loss",
        explanation: "P&L tracks how a position is moving after entry.",
      },
      {
        id: idGenerator(12),
        type: "true-false",
        prompt: "A trade can move against you after entry.",
        options: ["True", "False"],
        correctAnswer: "True",
        explanation: "Markets move both ways, so risk control matters.",
      },
      {
        id: idGenerator(12),
        type: "multiple-choice",
        prompt: "Which balance should be used before joining a trade?",
        options: ["Available balance", "Pending withdrawal", "Hidden balance", "Used gift card"],
        correctAnswer: "Available balance",
        explanation: "Only available balance can be locked into a new trade.",
      },
    ],
  };
}

class QuestService {
  constructor({ db, financialService, persist = () => undefined, idGenerator = randomId, clock = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.financialService = financialService;
    this.persist = persist;
    this.idGenerator = idGenerator;
    this.clock = clock;
  }

  ensureState() {
    this.db.quests = Array.isArray(this.db.quests) ? this.db.quests : [];
    this.db.questSessions = Array.isArray(this.db.questSessions) ? this.db.questSessions : [];
    this.db.userQuestProgress = Array.isArray(this.db.userQuestProgress) ? this.db.userQuestProgress : [];
    this.db.giftCards = Array.isArray(this.db.giftCards) ? this.db.giftCards : [];
    if (!this.db.quests.length) {
      this.db.quests.push(createDefaultQuest(this.clock, this.idGenerator));
    }
  }

  sanitizeQuest(quest, { includeAnswers = false } = {}) {
    const next = clone(quest);
    next.stages = (next.stages || []).map((stage, index) => {
      const sanitized = {
        id: stage.id,
        type: stage.type,
        prompt: stage.prompt,
        options: stage.options || [],
        pairs: stage.pairs || [],
        orderItems: stage.orderItems || [],
        hint: stage.hint || "",
        index,
      };
      if (includeAnswers) {
        sanitized.correctAnswer = stage.correctAnswer;
        sanitized.explanation = stage.explanation || "";
      }
      return sanitized;
    });
    return next;
  }

  isQuestLive(quest, nowMs = Date.now()) {
    if (!quest || quest.deletedAt || quest.manuallyDisabled || quest.active === false || quest.autoDisabledReason) {
      return false;
    }
    const startsAt = parseDateMs(quest.startsAt);
    const endsAt = parseDateMs(quest.endsAt);
    if (startsAt && startsAt > nowMs) {
      return false;
    }
    if (endsAt && endsAt < nowMs) {
      return false;
    }
    return true;
  }

  normalizeQuestInput(input = {}, actor = {}) {
    const title = normalizeText(input.title);
    if (!title) {
      throw new Error("Quest title is required.");
    }
    const stages = Array.isArray(input.stages) ? input.stages : [];
    if (!stages.length) {
      throw new Error("Add at least one quest stage.");
    }
    return {
      title,
      category: normalizeCategory(input.category || "crypto"),
      difficulty: normalizeText(input.difficulty || "easy") || "easy",
      description: normalizeText(input.description),
      active: input.active !== false,
      manuallyDisabled: input.active === false,
      autoDisabledReason: "",
      startsAt: input.startsAt || null,
      endsAt: input.endsAt || null,
      updatedAt: this.clock(),
      updatedBy: actor.id || "",
      stages: stages.map((stage) => {
        const prompt = normalizeText(stage.prompt);
        if (!prompt) {
          throw new Error("Every quest stage needs a prompt.");
        }
        const correctAnswer = stage.correctAnswer;
        if (correctAnswer === undefined || correctAnswer === null || normalizeText(correctAnswer) === "") {
          throw new Error("Every quest stage needs a correct answer.");
        }
        return {
          id: stage.id || this.idGenerator(12),
          type: normalizeStageType(stage.type),
          prompt,
          options: Array.isArray(stage.options) ? stage.options.map(normalizeText).filter(Boolean) : [],
          pairs: Array.isArray(stage.pairs) ? stage.pairs : [],
          orderItems: Array.isArray(stage.orderItems) ? stage.orderItems.map(normalizeText).filter(Boolean) : [],
          correctAnswer,
          explanation: normalizeText(stage.explanation),
          hint: normalizeText(stage.hint),
        };
      }),
    };
  }

  getProgress(userId) {
    this.ensureState();
    let progress = this.db.userQuestProgress.find((item) => item.userId === userId);
    if (!progress) {
      progress = {
        id: this.idGenerator(12),
        userId,
        lastQuestCompletedAt: null,
        nextQuestAvailableAt: null,
        totalStarted: 0,
        totalCompleted: 0,
        totalRewards: 0,
        createdAt: this.clock(),
        updatedAt: this.clock(),
      };
      this.db.userQuestProgress.push(progress);
    }
    return progress;
  }

  getRewardCards({ availableOnly = false } = {}) {
    this.ensureState();
    return this.db.giftCards.filter((card) => {
      const isQuestReward = card.isQuestReward === true || String(card.rewardPool || "").toLowerCase() === "quest";
      if (!isQuestReward) {
        return false;
      }
      if (!availableOnly) {
        return true;
      }
      return AVAILABLE_REWARD_STATUSES.includes(String(card.status || "").toUpperCase());
    });
  }

  syncQuestAvailability(actor = { id: "system", role: "system" }, requestMeta = {}) {
    this.ensureState();
    const availableRewards = this.getRewardCards({ availableOnly: true }).length;
    const now = this.clock();
    let changed = false;
    for (const quest of this.db.quests) {
      if (quest.deletedAt || quest.manuallyDisabled) {
        continue;
      }
      if (availableRewards <= 0) {
        if (!quest.autoDisabledReason) {
          quest.autoDisabledReason = "NO_REWARD_POOL";
          quest.active = false;
          quest.updatedAt = now;
          changed = true;
        }
      } else if (quest.autoDisabledReason === "NO_REWARD_POOL") {
        quest.autoDisabledReason = "";
        quest.active = true;
        quest.updatedAt = now;
        changed = true;
      }
    }
    if (changed) {
      this.financialService?.audit?.(actor, "QUEST_AVAILABILITY_SYNCED", "Quest", "all", { availableRewards }, requestMeta);
      this.persist();
    }
    return { availableRewards, changed };
  }

  getActiveQuest() {
    const nowMs = Date.parse(this.clock());
    return this.db.quests
      .filter((quest) => this.isQuestLive(quest, nowMs))
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))[0] || null;
  }

  getActiveSession(userId) {
    return this.db.questSessions.find((session) => {
      return session.userId === userId && ACTIVE_SESSION_STATUSES.includes(String(session.status || "").toUpperCase());
    }) || null;
  }

  getUserStatus(user) {
    this.syncQuestAvailability();
    const progress = this.getProgress(user.id);
    const nowMs = Date.parse(this.clock());
    const nextAvailableMs = parseDateMs(progress.nextQuestAvailableAt);
    const cooldownRemainingMs = nextAvailableMs && nextAvailableMs > nowMs ? nextAvailableMs - nowMs : 0;
    const activeQuest = this.getActiveQuest();
    const activeSession = this.getActiveSession(user.id);
    const rewardCards = this.getRewardCards();
    const availableRewardCount = rewardCards.filter((card) => AVAILABLE_REWARD_STATUSES.includes(String(card.status || "").toUpperCase())).length;
    const reward = activeSession?.rewardId
      ? this.db.giftCards.find((card) => card.id === activeSession.rewardId) || null
      : null;
    const unavailableReason = !availableRewardCount
      ? "REWARD_POOL_EMPTY"
      : !activeQuest
        ? "NO_ACTIVE_QUEST"
        : cooldownRemainingMs > 0
          ? "COOLDOWN"
          : "";
    return {
      serverNow: this.clock(),
      cooldownRemainingMs,
      nextQuestAvailableAt: progress.nextQuestAvailableAt,
      canStart: !!activeQuest && !activeSession && !cooldownRemainingMs && availableRewardCount > 0,
      unavailableReason,
      activeQuest: activeQuest ? this.sanitizeQuest(activeQuest) : null,
      activeSession: activeSession ? this.sanitizeSession(activeSession, activeQuest) : null,
      reward: reward ? this.sanitizeReward(reward, { revealSecret: String(reward.status || "").toUpperCase() !== "ASSIGNED" }) : null,
      rewardPool: {
        total: rewardCards.length,
        available: availableRewardCount,
      },
      progress: clone(progress),
    };
  }

  sanitizeSession(session, quest = null) {
    const sourceQuest = quest || this.db.quests.find((item) => item.id === session.questId) || session.questSnapshot || null;
    const currentStage = sourceQuest?.stages?.[session.currentStageIndex || 0] || null;
    return {
      id: session.id,
      questId: session.questId,
      status: session.status,
      currentStageIndex: session.currentStageIndex || 0,
      totalStages: sourceQuest?.stages?.length || 0,
      startedAt: session.startedAt,
      completedAt: session.completedAt || null,
      rewardId: session.rewardId || "",
      currentStage: currentStage ? this.sanitizeQuest({ stages: [currentStage] }).stages[0] : null,
    };
  }

  sanitizeReward(card, { revealSecret = false } = {}) {
    return {
      id: card.id,
      amount: card.amount,
      currency: card.currency,
      status: card.status,
      note: card.note || "Netrue Quest Reward",
      code: revealSecret ? card.code : "",
      pin: revealSecret ? card.pin || "" : "",
      assignedAt: card.assignedAt || null,
      revealedAt: card.revealedAt || null,
      redeemedAt: card.redeemedAt || null,
      transactionId: card.transactionId || "",
    };
  }

  startQuest(user, questId = "", requestMeta = {}) {
    this.ensureState();
    const status = this.getUserStatus(user);
    if (status.activeSession) {
      return { session: status.activeSession, quest: status.activeQuest };
    }
    if (!status.canStart) {
      throw new Error(status.unavailableReason === "COOLDOWN"
        ? "Quest cooldown is still active."
        : "No quest reward is available right now.");
    }
    const quest = questId
      ? this.db.quests.find((item) => item.id === questId)
      : this.getActiveQuest();
    if (!this.isQuestLive(quest, Date.parse(this.clock()))) {
      throw new Error("This quest is not active.");
    }
    const progress = this.getProgress(user.id);
    const session = {
      id: this.idGenerator(12),
      userId: user.id,
      userName: user.name || "",
      userEmail: user.email || "",
      questId: quest.id,
      questTitle: quest.title,
      questSnapshot: clone(quest),
      status: "IN_PROGRESS",
      currentStageIndex: 0,
      answers: [],
      rewardId: "",
      startedAt: this.clock(),
      completedAt: null,
      rewardAssignedAt: null,
      rewardRedeemedAt: null,
    };
    this.db.questSessions.unshift(session);
    quest.stats = quest.stats || {};
    quest.stats.started = Number(quest.stats.started || 0) + 1;
    progress.totalStarted = Number(progress.totalStarted || 0) + 1;
    progress.currentSessionId = session.id;
    progress.updatedAt = this.clock();
    this.financialService?.audit?.(user, "QUEST_STARTED", "Quest", quest.id, { sessionId: session.id }, requestMeta);
    this.persist();
    return { session: this.sanitizeSession(session, quest), quest: this.sanitizeQuest(quest) };
  }

  answerStage(user, sessionId, input = {}, requestMeta = {}) {
    this.ensureState();
    const session = this.requireUserSession(user, sessionId);
    if (!["IN_PROGRESS", "STARTED"].includes(String(session.status || "").toUpperCase())) {
      throw new Error("This quest stage is already complete.");
    }
    const quest = session.questSnapshot || this.db.quests.find((item) => item.id === session.questId);
    const index = Number(session.currentStageIndex || 0);
    const stage = quest?.stages?.[index];
    if (!stage) {
      throw new Error("Quest stage not found.");
    }
    const answer = input.answer;
    if (!answersMatch(stage.correctAnswer, answer)) {
      this.financialService?.audit?.(user, "QUEST_STAGE_FAILED", "QuestSession", session.id, { stageId: stage.id }, requestMeta);
      return {
        correct: false,
        message: "Try again.",
        session: this.sanitizeSession(session, quest),
      };
    }
    session.answers.push({
      stageId: stage.id,
      answer,
      answeredAt: this.clock(),
    });
    session.currentStageIndex = index + 1;
    const completed = session.currentStageIndex >= (quest.stages || []).length;
    if (completed) {
      session.status = "COMPLETED";
    }
    this.persist();
    return {
      correct: true,
      completed,
      explanation: stage.explanation || "",
      session: this.sanitizeSession(session, quest),
    };
  }

  completeQuest(user, sessionId, requestMeta = {}) {
    this.ensureState();
    const session = this.requireUserSession(user, sessionId);
    if (session.rewardId) {
      const reward = this.db.giftCards.find((card) => card.id === session.rewardId);
      return {
        session: this.sanitizeSession(session),
        reward: reward ? this.sanitizeReward(reward) : null,
      };
    }
    const quest = session.questSnapshot || this.db.quests.find((item) => item.id === session.questId);
    if ((session.currentStageIndex || 0) < (quest?.stages?.length || 0)) {
      throw new Error("Complete every quest stage first.");
    }
    const reward = this.assignReward(user, session, quest, requestMeta);
    const progress = this.getProgress(user.id);
    progress.lastQuestCompletedAt = this.clock();
    progress.nextQuestAvailableAt = new Date(Date.parse(this.clock()) + QUEST_COOLDOWN_MS).toISOString();
    progress.totalCompleted = Number(progress.totalCompleted || 0) + 1;
    progress.totalRewards = Number(progress.totalRewards || 0) + 1;
    progress.currentSessionId = "";
    progress.updatedAt = this.clock();
    quest.stats = quest.stats || {};
    quest.stats.completed = Number(quest.stats.completed || 0) + 1;
    quest.stats.rewarded = Number(quest.stats.rewarded || 0) + 1;
    session.status = "REWARD_ASSIGNED";
    session.completedAt = session.completedAt || this.clock();
    session.rewardAssignedAt = this.clock();
    this.financialService?.createNotification?.({
      userId: user.id,
      type: "QUEST",
      title: "Quest reward unlocked",
      message: "Scratch your Netrue Quest card.",
      entityType: "QuestSession",
      entityId: session.id,
    });
    this.financialService?.audit?.(user, "QUEST_COMPLETED", "Quest", quest.id, { sessionId: session.id, rewardId: reward.id }, requestMeta);
    this.persist();
    return {
      session: this.sanitizeSession(session, quest),
      reward: this.sanitizeReward(reward),
      nextQuestAvailableAt: progress.nextQuestAvailableAt,
    };
  }

  assignReward(user, session, quest, requestMeta = {}) {
    const rewards = this.getRewardCards({ availableOnly: true });
    if (!rewards.length) {
      this.syncQuestAvailability(user, requestMeta);
      throw new Error("Quest rewards are not available right now.");
    }
    const reward = rewards[crypto.randomInt(0, rewards.length)];
    if (String(reward.status || "").toUpperCase() !== "UNUSED") {
      throw new Error("Quest reward is no longer available.");
    }
    reward.status = "ASSIGNED";
    reward.assignedTo = user.id;
    reward.assignedToName = user.name || "";
    reward.assignedToEmail = user.email || "";
    reward.assignedAt = this.clock();
    reward.questId = quest.id;
    reward.questSessionId = session.id;
    session.rewardId = reward.id;
    return reward;
  }

  revealReward(user, sessionId, requestMeta = {}) {
    this.ensureState();
    const session = this.requireUserSession(user, sessionId);
    const reward = this.requireSessionReward(user, session);
    if (String(reward.status || "").toUpperCase() === "ASSIGNED") {
      reward.status = "REVEALED";
      reward.revealedAt = this.clock();
      session.status = "REVEALED";
      this.financialService?.audit?.(user, "QUEST_REWARD_REVEALED", "GiftCard", reward.id, { sessionId: session.id }, requestMeta);
      this.persist();
    }
    return {
      session: this.sanitizeSession(session),
      reward: this.sanitizeReward(reward, { revealSecret: true }),
    };
  }

  redeemReward(user, sessionId, requestMeta = {}) {
    this.ensureState();
    const session = this.requireUserSession(user, sessionId);
    const reward = this.requireSessionReward(user, session);
    if (String(reward.status || "").toUpperCase() === "ASSIGNED") {
      reward.status = "REVEALED";
      reward.revealedAt = this.clock();
      session.status = "REVEALED";
    }
    const result = this.financialService.redeemGiftCard(
      user,
      { code: reward.code, pin: reward.pin },
      {
        ...requestMeta,
        idempotencyKey: requestMeta.idempotencyKey || `quest-reward:${session.id}:${reward.id}`,
      }
    );
    session.status = "REDEEMED";
    session.rewardRedeemedAt = this.clock();
    const quest = this.db.quests.find((item) => item.id === session.questId) || session.questSnapshot || {};
    quest.stats = quest.stats || {};
    quest.stats.redeemed = Number(quest.stats.redeemed || 0) + 1;
    this.financialService?.audit?.(user, "QUEST_REWARD_REDEEMED", "GiftCard", reward.id, { sessionId: session.id }, requestMeta);
    this.persist();
    return {
      ...result,
      session: this.sanitizeSession(session),
      reward: this.sanitizeReward(reward, { revealSecret: true }),
    };
  }

  requireUserSession(user, sessionId) {
    const id = normalizeText(sessionId);
    const session = this.db.questSessions.find((item) => item.id === id && item.userId === user.id);
    if (!session) {
      throw new Error("Quest session not found.");
    }
    return session;
  }

  requireSessionReward(user, session) {
    const reward = this.db.giftCards.find((card) => card.id === session.rewardId);
    if (!reward || reward.assignedTo !== user.id) {
      throw new Error("Quest reward not found.");
    }
    return reward;
  }

  listHistory(user, { limit = 100 } = {}) {
    this.ensureState();
    return this.db.questSessions
      .filter((session) => session.userId === user.id)
      .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0))
      .slice(0, limit)
      .map((session) => this.sanitizeSession(session));
  }

  listRewards(user, { limit = 100 } = {}) {
    this.ensureState();
    return this.getRewardCards()
      .filter((card) => card.assignedTo === user.id || card.redeemedByUserId === user.id)
      .sort((a, b) => Date.parse(b.assignedAt || b.redeemedAt || b.createdAt || 0) - Date.parse(a.assignedAt || a.redeemedAt || a.createdAt || 0))
      .slice(0, limit)
      .map((card) => this.sanitizeReward(card, { revealSecret: ["REVEALED", "USED"].includes(String(card.status || "").toUpperCase()) }));
  }

  listAdminQuests(admin) {
    this.requireAdmin(admin);
    this.syncQuestAvailability(admin);
    return this.db.quests
      .filter((quest) => !quest.deletedAt)
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
      .map((quest) => this.sanitizeQuest(quest, { includeAnswers: true }));
  }

  getAdminQuest(admin, questId) {
    this.requireAdmin(admin);
    const quest = this.db.quests.find((item) => item.id === normalizeText(questId) && !item.deletedAt);
    if (!quest) {
      throw new Error("Quest not found.");
    }
    return this.sanitizeQuest(quest, { includeAnswers: true });
  }

  createQuest(admin, input = {}, requestMeta = {}) {
    this.requireAdmin(admin);
    const quest = {
      id: this.idGenerator(12),
      ...this.normalizeQuestInput(input, admin),
      createdAt: this.clock(),
      createdBy: admin.id,
      deletedAt: null,
      stats: {
        started: 0,
        completed: 0,
        rewarded: 0,
        redeemed: 0,
      },
    };
    this.db.quests.unshift(quest);
    this.syncQuestAvailability(admin, requestMeta);
    this.financialService?.audit?.(admin, "QUEST_CREATED", "Quest", quest.id, { title: quest.title }, requestMeta);
    this.persist();
    return this.sanitizeQuest(quest, { includeAnswers: true });
  }

  updateQuest(admin, questId, input = {}, requestMeta = {}) {
    this.requireAdmin(admin);
    const quest = this.db.quests.find((item) => item.id === normalizeText(questId) && !item.deletedAt);
    if (!quest) {
      throw new Error("Quest not found.");
    }
    Object.assign(quest, this.normalizeQuestInput(input, admin));
    this.syncQuestAvailability(admin, requestMeta);
    this.financialService?.audit?.(admin, "QUEST_UPDATED", "Quest", quest.id, { title: quest.title }, requestMeta);
    this.persist();
    return this.sanitizeQuest(quest, { includeAnswers: true });
  }

  setQuestActive(admin, questId, active, requestMeta = {}) {
    this.requireAdmin(admin);
    const quest = this.db.quests.find((item) => item.id === normalizeText(questId) && !item.deletedAt);
    if (!quest) {
      throw new Error("Quest not found.");
    }
    quest.active = !!active;
    quest.manuallyDisabled = !active;
    quest.autoDisabledReason = active ? "" : quest.autoDisabledReason;
    quest.updatedAt = this.clock();
    quest.updatedBy = admin.id;
    this.syncQuestAvailability(admin, requestMeta);
    this.financialService?.audit?.(admin, active ? "QUEST_ACTIVATED" : "QUEST_DISABLED", "Quest", quest.id, {}, requestMeta);
    this.persist();
    return this.sanitizeQuest(quest, { includeAnswers: true });
  }

  deleteQuest(admin, questId, requestMeta = {}) {
    this.requireAdmin(admin);
    const quest = this.db.quests.find((item) => item.id === normalizeText(questId) && !item.deletedAt);
    if (!quest) {
      throw new Error("Quest not found.");
    }
    quest.deletedAt = this.clock();
    quest.deletedBy = admin.id;
    quest.active = false;
    this.financialService?.audit?.(admin, "QUEST_DELETED", "Quest", quest.id, {}, requestMeta);
    this.persist();
    return { deleted: true, questId: quest.id };
  }

  duplicateQuest(admin, questId, requestMeta = {}) {
    this.requireAdmin(admin);
    const source = this.db.quests.find((item) => item.id === normalizeText(questId) && !item.deletedAt);
    if (!source) {
      throw new Error("Quest not found.");
    }
    const duplicate = clone(source);
    duplicate.id = this.idGenerator(12);
    duplicate.title = `${source.title} Copy`;
    duplicate.active = false;
    duplicate.manuallyDisabled = true;
    duplicate.autoDisabledReason = "";
    duplicate.createdAt = this.clock();
    duplicate.updatedAt = this.clock();
    duplicate.createdBy = admin.id;
    duplicate.deletedAt = null;
    duplicate.stats = { started: 0, completed: 0, rewarded: 0, redeemed: 0 };
    duplicate.stages = (duplicate.stages || []).map((stage) => ({ ...stage, id: this.idGenerator(12) }));
    this.db.quests.unshift(duplicate);
    this.financialService?.audit?.(admin, "QUEST_DUPLICATED", "Quest", duplicate.id, { sourceId: source.id }, requestMeta);
    this.persist();
    return this.sanitizeQuest(duplicate, { includeAnswers: true });
  }

  getQuestStats(admin, questId = "") {
    this.requireAdmin(admin);
    const sessions = this.db.questSessions.filter((session) => !questId || session.questId === questId);
    return {
      totalStarted: sessions.length,
      totalCompleted: sessions.filter((session) => ["COMPLETED", "REWARD_ASSIGNED", "REVEALED", "REDEEMED"].includes(String(session.status || "").toUpperCase())).length,
      totalRewards: sessions.filter((session) => session.rewardId).length,
      totalRedeemed: sessions.filter((session) => String(session.status || "").toUpperCase() === "REDEEMED").length,
      recentSessions: sessions
        .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0))
        .slice(0, 20)
        .map((session) => this.sanitizeSession(session)),
    };
  }

  getRewardVaultStatus(admin) {
    this.requireAdmin(admin);
    const cards = this.getRewardCards();
    const byStatus = cards.reduce((memo, card) => {
      const status = String(card.status || "UNUSED").toUpperCase();
      memo[status] = Number(memo[status] || 0) + 1;
      return memo;
    }, {});
    return {
      total: cards.length,
      available: byStatus.UNUSED || 0,
      assigned: byStatus.ASSIGNED || 0,
      revealed: byStatus.REVEALED || 0,
      redeemed: byStatus.USED || 0,
      lowInventory: Number(byStatus.UNUSED || 0) <= 3,
      cards: cards
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
        .slice(0, 100)
        .map((card) => this.sanitizeReward(card, { revealSecret: true })),
    };
  }

  requireAdmin(admin) {
    this.ensureState();
    if (!admin || admin.role !== "admin") {
      throw new Error("Admin access is required.");
    }
  }
}

module.exports = {
  QuestService,
  QUEST_CATEGORIES,
  QUEST_COOLDOWN_MS,
};
