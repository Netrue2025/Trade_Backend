const test = require("node:test");
const assert = require("node:assert/strict");

const { FinancialService } = require("../services/financialService");
const { QuestService, QUEST_COOLDOWN_MS } = require("../services/questService");

function createHarness() {
  let id = 0;
  let nowMs = Date.parse("2026-09-05T08:00:00.000Z");
  const db = {
    users: [
      { id: "admin-1", name: "Admin", email: "admin@example.com", role: "admin" },
      { id: "user-1", name: "Ada User", email: "ada@example.com", role: "user" },
      { id: "user-2", name: "Ben User", email: "ben@example.com", role: "user" },
    ],
  };
  const nextId = () => `id-${++id}`;
  const clock = () => new Date(nowMs).toISOString();
  const financialService = new FinancialService({
    db,
    persist: () => undefined,
    idGenerator: nextId,
    clock,
  });
  financialService.ensureState();
  const questService = new QuestService({
    db,
    financialService,
    persist: () => undefined,
    idGenerator: nextId,
    clock,
  });
  questService.ensureState();
  return {
    admin: db.users[0],
    user: db.users[1],
    otherUser: db.users[2],
    db,
    financialService,
    questService,
    tick: (ms) => {
      nowMs += ms;
    },
  };
}

function createQuestReward(harness, amount = "1500") {
  return harness.financialService.createGiftCard(harness.admin, {
    amount,
    currency: "NGN",
    note: "Quest reward",
    rewardPool: "quest",
    isQuestReward: true,
  });
}

test("quest is unavailable when the reward pool is empty", () => {
  const { questService, user } = createHarness();

  const status = questService.getUserStatus(user);

  assert.equal(status.canStart, false);
  assert.equal(status.unavailableReason, "REWARD_POOL_EMPTY");
});

test("user answers quest stages and receives an assigned reward", () => {
  const harness = createHarness();
  const { questService, user, db } = harness;
  createQuestReward(harness, "2500");

  const status = questService.getUserStatus(user);
  const started = questService.startQuest(user, status.activeQuest.id);
  assert.equal(started.session.currentStageIndex, 0);

  const wrong = questService.answerStage(user, started.session.id, { answer: "Password and login" });
  assert.equal(wrong.correct, false);
  assert.equal(wrong.session.currentStageIndex, 0);

  let sessionId = started.session.id;
  for (const stage of started.quest.stages) {
    const sourceStage = db.quests[0].stages.find((item) => item.id === stage.id);
    const answer = questService.answerStage(user, sessionId, { answer: sourceStage.correctAnswer });
    assert.equal(answer.correct, true);
  }

  const completed = questService.completeQuest(user, sessionId);
  assert.equal(completed.session.status, "REWARD_ASSIGNED");
  assert.equal(completed.reward.status, "ASSIGNED");
  assert.equal(db.giftCards[0].assignedTo, user.id);
});

test("quest completion is idempotent and starts cooldown", () => {
  const harness = createHarness();
  const { questService, user, db } = harness;
  createQuestReward(harness, "2500");
  createQuestReward(harness, "3000");

  const started = questService.startQuest(user, questService.getUserStatus(user).activeQuest.id);
  for (const stage of db.quests[0].stages) {
    questService.answerStage(user, started.session.id, { answer: stage.correctAnswer });
  }
  const first = questService.completeQuest(user, started.session.id);
  const second = questService.completeQuest(user, started.session.id);
  assert.equal(second.reward.id, first.reward.id);
  assert.equal(questService.getUserStatus(user).canStart, false);

  questService.redeemReward(user, started.session.id);
  harness.tick(QUEST_COOLDOWN_MS + 1);
  assert.equal(questService.getUserStatus(user).canStart, true);
});

test("quest reward reveal and wallet redemption credit once", () => {
  const harness = createHarness();
  const { questService, financialService, user, otherUser, db } = harness;
  createQuestReward(harness, "1200");

  const started = questService.startQuest(user, questService.getUserStatus(user).activeQuest.id);
  for (const stage of db.quests[0].stages) {
    questService.answerStage(user, started.session.id, { answer: stage.correctAnswer });
  }
  questService.completeQuest(user, started.session.id);
  assert.throws(() => questService.revealReward(otherUser, started.session.id), /not found/i);

  const revealed = questService.revealReward(user, started.session.id);
  assert.match(revealed.reward.code, /^\d{14}$/);
  assert.match(revealed.reward.pin, /^\d{6}$/);

  const redeemed = questService.redeemReward(user, started.session.id);
  assert.equal(redeemed.reward.status, "USED");
  assert.equal(financialService.ensureWallet(user.id, "NGN").availableBalance, "1200");
  assert.equal(questService.redeemReward(user, started.session.id).transaction.id, redeemed.transaction.id);
});

test("admin can create, disable, duplicate, and delete quests", () => {
  const { admin, questService, db } = createHarness();
  createQuestReward({ admin, financialService: questService.financialService });
  const quest = questService.createQuest(admin, {
    title: "AI Quest",
    category: "AI",
    description: "Learn fast",
    stages: [
      {
        type: "multiple-choice",
        prompt: "What does AI stand for?",
        options: ["Artificial intelligence", "Asset index"],
        correctAnswer: "Artificial intelligence",
      },
    ],
  });

  assert.equal(quest.category, "AI");
  assert.equal(questService.setQuestActive(admin, quest.id, false).active, false);
  const copy = questService.duplicateQuest(admin, quest.id);
  assert.notEqual(copy.id, quest.id);
  assert.equal(copy.active, false);
  assert.equal(questService.deleteQuest(admin, quest.id).deleted, true);
  assert.equal(db.quests.some((item) => item.id === quest.id && item.deletedAt), true);
});
