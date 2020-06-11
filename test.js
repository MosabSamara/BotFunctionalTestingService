var _ = require("underscore");
var uuid = require("uuid");

var assert = require("chai").assert;
var expect = require("chai").expect;
var diff = require("deep-object-diff").diff;

var directline = require("./directlineclient");
var utils = require("./utils.js");
var Result = require("./result");

class Test {
    static async perform(context, testData) {
        return await test(context, testData);
    }

    static async run(context, testData) {
        var testResult = await this.perform(context, testData);
        if (testResult.success) {
            context.success(testResult.message);
        }
        else {
            context.failure(testResult.code, testResult.message);
        }
    }
}

async function test(context, testData) {
    context.log("test started");
    context.log("testData: " + utils.stringify(testData));
    // Break the conversation into messages from the user side vs. replies from the bot side
    // Each conversation step contains an array of user messages (typically one) and an array of bot replies (typically one, but it's normal to have more than one)
    // For each conversation step, first send the user message and then wait for the expected reply
    var testUserId = "test-user-" + uuid().substring(0, 8);
    var conversationSteps = createConversationSteps(testData);
    try {
        var initResult = await directline.init(context, testData.secret);
        testData.trialsCount = -1;
        testData.prevTrialsCount = -1;
        testData.decreasedAtLeastOnce = false;
        testData.testEnded = false;
        var conversationResult = await testConversation(context, testUserId, conversationSteps, initResult.conversationId, testData);
        var message = `${getTestTitle(testData)} passed successfully (${conversationResult.count} ${conversationResult.count == 1 ? "step" : "steps"} passed)`;
        return new Result(true, message);
    }
    catch (err) {
        var reason;
        if (err.hasOwnProperty("details")) {
            reason = err.details;
            if (reason && reason.hasOwnProperty("message")) {
                reason.message = getTestTitle(testData) + ": " + reason.message;
            }
        }
        else {
            reason = getTestTitle(testData) + ": " + err.message;
        }
        return new Result(false, reason, 500);
    }
}

function createConversationSteps(testData) {
    conversation = [];
    // Assuming that each user message is followed by at least one bot reply

    // Check whether the first message is from the bot
    if (!isUserMessage(testData, testData.messages[0])) {
        // If the first message is from the but, start with a special step with no user message
        conversation.push(new conversationStep(null));
    }
    for (var i = 0; i < testData.messages.length; i++) {
        var message = testData.messages[i];
        if (isUserMessage(testData, message)) {
            // User message - start a new step
            conversation.push(new conversationStep(message));
        }
        else {
            // Bot message - add the bot reply to the current step
            conversation[conversation.length - 1].botReplies.push(message);
        }
    }
    return conversation;
}

function isUserMessage(testData, message) {
    return (testData && testData.userId) ? (message.from.id == testData.userId) : (message.recipient ? (message.recipient.role == "bot") : (message.from.role != "bot"));
}

function conversationStep(message) {
    this.userMessage = message;
    this.botReplies = [];
}

function checkIfConversationEnded(testData) {
    return testData.lastMessageFromBot && testData.lastMessageFromBot.hasOwnProperty("text") &&
        (testData.lastMessageFromBot.text.trim().includes('Thank you for using this service for COVID-19 Clinical Trials Matching.') ||
            testData.lastMessageFromBot.text.trim() === 'Here are the clinical trials the patient may qualify for:')
}
function testConversation(context, testUserId, conversationSteps, conversationId, testData) {
    context.log("testConversation started");
    context.log("testUserId: " + testUserId);
    context.log("conversationSteps: " + utils.stringify(conversationSteps));
    context.log("conversationId: " + conversationId);
    context.log("defaultTimeout: " + testData.timeout);
    return new Promise(function (resolve, reject) {
        var index = 0;
        function nextStep() {
            if (!testData.testEnded) {
                context.log("Testing conversation step " + index);
                var stepData = {};
                if (checkIfConversationEnded(testData)) {
                    testData.testEnded = true;
                    stepData.userMessage = testData.lastMessageFromBot;
                }
                else {
                    stepData.userMessage = testData.lastMessageFromBot;
                }
                if (index < conversationSteps.length)
                    stepData = conversationSteps[index];
                index++;
                var userMessage = createUserMessage(stepData.userMessage, testUserId);
                return testStep(context, conversationId, userMessage, stepData.botReplies, testData).then(nextStep, reject);
            }
            else {
                context.log("testConversation end");
                resolve({ count: index });
            }
        }
        return nextStep();
    });
}

function createUserMessage(message, testUserId) {
    var userMessage = _.pick(message, "type", "text", "value");
    userMessage.from = {
        id: testUserId,
        name: "Test User"
    };
    return userMessage;
}

function isLastStep(message) {
    return message && message.hasOwnProperty("text") &&
        message.text.trim() === 'What would you like to do?' &&
        message.hasOwnProperty("attachments") &&
        message.attachments[0].content.buttons[0].title === 'Answer additional questions';
}
function isNumericQuestion(lastMessageFromBot) {
    let numericQuestions = /^([Ww]hat is the patient's).*\?/g;
    return lastMessageFromBot && lastMessageFromBot.hasOwnProperty("text") &&
        numericQuestions.exec(lastMessageFromBot.text) &&
        lastMessageFromBot.text != "What is the patient's condition?"
}

function isChoicesQuestion(lastMessageFromBot) {
    let yesNoQuestionRegex = /^([Ww]as|[Dd]id|[Ww]hat is the patient's ECOG score|[Ii]s).*\?/g;
    return lastMessageFromBot &&
        lastMessageFromBot.hasOwnProperty("text") &&
        yesNoQuestionRegex.exec(lastMessageFromBot.text)
}

function testStep(context, conversationId, userMessage, expectedReplies, testData) {
    context.log("testStep started");
    context.log("conversationId: " + conversationId);
    context.log("userMessage: " + utils.stringify(userMessage));
    context.log("expectedReplies: " + utils.stringify(expectedReplies));
    context.log("timeoutMilliseconds: " + testData.timeout);
    if (testData && testData.lastMessageFromBot && isLastStep(testData.lastMessageFromBot))
        userMessage.text = "2"; // 2 equals 'Get Results'
    else if (isChoicesQuestion(testData.lastMessageFromBot))
        userMessage.text = "1"; // first choice
    else if (isNumericQuestion(testData.lastMessageFromBot))
        userMessage.text = "20";

    return directline.sendMessage(conversationId, userMessage)
        .then(function (response) {
            var nMessages = (expectedReplies && expectedReplies.hasOwnProperty("length")) ? expectedReplies.length : 1;
            var bUserMessageIncluded = response != null;
            return directline.pollMessages(conversationId, nMessages, bUserMessageIncluded, testData.timeout);
        })
        .then(function (messages) {
            return compareMessages(context, userMessage, expectedReplies, messages, testData);
        })
        .catch(function (err) {
            var message = `User message '${userMessage.text}' response failed - ${err.message}`;
            if (err.hasOwnProperty("details")) {
                err.details.message = message;
            }
            else {
                err.message = message;
            }
            throw err;
        });
}

function assertThatCardsFieldsAreNotEmpty(card) {
    let fields = Object.keys(card);
    for (let i = 0; i < fields.length; i++) {
        if (typeof (fields[i]) === 'object') {
            assertThatCardsFieldsAreNotEmpty(fields[i]);
        }
        else {
            expect(card[fields[i]], "Cards contains empty field").to.not.be.empty;
        }
    }
}

function compareMessages(context, userMessage, expectedReplies, actualMessages, testData) {
    context.log("compareMessages started");
    context.log("actualMessages: " + utils.stringify(actualMessages));
    // Filter out messages from the (test) user, leaving only bot replies
    var botReplies = _.reject(actualMessages,
        function (message) {
            return message.from.id == userMessage.from.id;
        });
    testData.lastMessageFromBot = botReplies.reverse().find(message => message.text != undefined);
    for (let i = 0; i < expectedReplies.length; i++) {
        var botReply = botReplies[i];
        var trialsCountRegex = /Found \d+ relevant trials/g;
        if (botReply.hasOwnProperty("text")) {
            if (botReply.text === "Sorry, no relevant trials were found") {
                var exception = new Error("Initial trials count is ZERO");
                exception.details = { message: "Initial trials count is ZERO", expected: "Initial trials count > ZERO", actual: "Initial trials count = ZERO" };
                throw exception;
            }
            else {
                if (trialsCountRegex.exec(botReply.text)) { // if the message contains trials count don't assert literally
                    testData.trialsCount = parseInt(botReply.text.split(" ")[1]); // split on space => the second record will be trials' count
                    expect(testData.trialsCount, "Initial trials count is ZERO").to.be.greaterThan(0);
                    if (testData.prevTrialsCount > 0 && testData.prevTrialsCount > testData.trialsCount) {
                        testData.decreasedAtLeastOnce = true;
                    }
                    testData.prevTrialsCount = testData.trialsCount;
                }
                else {
                    if (checkIfConversationEnded(testData)) {
                        testData.testEnded = true;
                        expect(testData.decreasedAtLeastOnce, "Trials count didn't decrease").to.be.true;
                    }
                    expect(botReply.text, "The bot replied with empty text").to.not.be.empty;
                }
            }
        }
        if (botReply.hasOwnProperty("attachments")) {
            try {
                assertThatCardsFieldsAreNotEmpty(botReply.attachments);
                if (testData.testEnded) {
                    expect(botReply.attachments[0].content.body.length, "Final trials count is ZERO").to.be.greaterThan(0);
                }
            }
            catch (err) {
                var exception = new Error(err.message);
                exception.details = { message: err.message, expected: err.expected, actual: err.actual, diff: diff(err.expected, err.actual) };
                throw exception;
            }
        }
    }
    return true;
}

function getTestTitle(testData) {
    return `Test ${testData.name ? `'${testData.name}'` : `#${testData.index || 0}`}`;
}

module.exports = Test;
