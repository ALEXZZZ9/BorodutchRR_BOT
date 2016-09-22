'use strict'

/*
start - About
help - Help
*/

const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const request = require('request');

const log = require('./libs/log')(module);
const config = require('./config.json');
const SubscribersModel = require('./models/subscribers').SubscribersModel;
const strings = require('./strings');

const needMinCountHel = 500;
const maxCountHel = 100000;

const options = {
    polling: {timeout: 10, interval: 1000}
};

let isEnabled = true;
let isStarted = false;

let token = (config.debug) ? config.DEBUG_TELEGRAM_BOT_TOKEN : config.TELEGRAM_BOT_TOKEN;
let botName = '';

let gameStates = {
    no: 0,
    prePlaying: 1,
    playing: 2,
    gameOver: 3
};
let gameState = gameStates.no;

let subscribers = [];

let playingUsers = [];
let watchingUsers = [];
let scrolledUsers = [];
let ripUsers = [];
let namesUsersPlaying = [];

let currentGamePrice = 0;
let bulletIn = -1;
let currentBullet = -1;
let currentPlayer = -1;
let gameTimeoutId = -1;
let bank = 0;


function GetKeyboard(fromId) {
    let keyboardData = [strings.mainMenu.playOne, strings.mainMenu.playTwo];
    if (StateIs(gameStates.prePlaying)) keyboardData = [strings.mainMenu.play, strings.mainMenu.watch];
    if (StateIs(gameStates.playing)) keyboardData = [strings.mainMenu.watch, strings.mainMenu.back];

    let keyboard = {
        reply_markup: JSON.stringify({
            keyboard: [
                (keyboardData),
                [strings.mainMenu.balance, strings.mainMenu.donation],
                [( IsSubscriber(fromId) ? strings.mainMenu.unsubscribe : strings.mainMenu.subscribe), strings.mainMenu.help]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        })
    };


    if (!StateIs(gameStates.gameOver) && (StateIs(gameStates.prePlaying) || StateIs(gameStates.playing)) && watchingUsers.indexOf(fromId) > -1 && playingUsers.indexOf(fromId) === -1 && ripUsers.indexOf(fromId) === -1) {
        keyboard = {
            reply_markup: JSON.stringify({
                keyboard: [
                    ['Перестать смотреть']
                ],
                resize_keyboard: true,
                one_time_keyboard: true
            })
        };
    }

    return  keyboard;
}

let donateKeyboard = {
    reply_markup: JSON.stringify({
        inline_keyboard: [
            [{text: '10', callback_data: 'D10'}, {text: '50', callback_data: 'D50'}],
            [{text: '100', callback_data: 'D100'}, {text: '500', callback_data: 'D500'}],
            [{text: '1000', callback_data: 'D1000'}],
        ]
    })
};
let hideKeyboard = {
    reply_markup: JSON.stringify({
        keyboard: [],
        hide_keyboard: true
    })
};


let bot = new TelegramBot(token, options);

mongoose.connect(config.mongoose.uri);
let db = mongoose.connection;

db.on('error', err => {
    log.error('connection error:', err.message);
});
db.once('open', () => {
    log.info('Connected to DB!');
});


bot.getMe()
.then(me => {
    botName = me.username;
    log.info(`Bot ${me.username} is running!`);
    UpdateSubscribers();
    ResetGame();

    //Ignore all message by users within 2 seconds (To skip old commands)
    setTimeout(() => {
        isStarted = true;
    }, 2000);
});

bot.onText(/\/enable/, msg => {
    let chatId = msg.chat.id;
    //let userInfo = GetUserInfo(msg);

    if (!isStarted || chatId !== config.admins[0]){
        return;
    }

    isEnabled = true;

    SendMessage(chatId, `Bot Enabled`);
});

bot.onText(/\/disable/, msg => {
    let chatId = msg.chat.id;
    //let userInfo = GetUserInfo(msg);

    if (!isStarted || chatId !== config.admins[0]){
        return;
    }

    isEnabled = false;
    SendMessage(chatId, `Bot Disabled`);
});

bot.onText(/Играть (.+)/, (msg, match) => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (playingUsers.indexOf(userInfo.fromId) !== -1) {
        SendMessage(chatId, 'Вы уже участвуете!\nКак только игра начнётся, вы получите оповещение!', hideKeyboard);
        return;
    } else if (StateIs(gameStates.playing)) {
        SendMessage(chatId, 'Игра уже идёт!', GetKeyboard(userInfo.fromId));
        return;
    } else if (StateIs(gameStates.prePlaying)) {
        SendMessage(chatId, `Игра на ${currentGamePrice} гелиончиков скоро начнётся, хочешь присоединиться? Жми "Играть"!`, GetKeyboard(userInfo.fromId));
        return;
    } else if (StateIs(gameStates.gameOver)) {
        return;
    }


    if (!IsNumber(match[1])) {
        SendMessage(chatId, 'Введите корректную сумму!', GetKeyboard(userInfo.fromId));
        return;
    } else if (match[1] < needMinCountHel) {
        SendMessage(chatId, `Нельзя играть меньше чем на ${needMinCountHel}  гелиончиков!`, GetKeyboard(userInfo.fromId));
        return;
    } else if (match[1] > maxCountHel) {
        SendMessage(chatId, `Нельзя играть больше чем на ${maxCountHel} гелиончиков!`, GetKeyboard(userInfo.fromId));
        return;
    }

    Transfer(userInfo.forBUsername, config.TransferBotName, match[1], (err, status) => {
        if (!err) {
            playingUsers.push(userInfo.fromId);
            namesUsersPlaying.push(userInfo.forBUsername);
            StartGame(match[1]);
            SendMessage(chatId, 'У других игроков есть 1 минута, чтобы присоединиться к этой игре!\nИгра начнётся через 1 минуту, если к вам присоединится хотя бы 1 человек!', hideKeyboard);
        } else {
            SendMessage(chatId, 'У вас недостаточно гелиончиков!', GetKeyboard(userInfo.fromId));
        }
    });
});

bot.onText(/Играть$/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (playingUsers.indexOf(userInfo.fromId) !== -1) {
        SendMessage(chatId, 'Вы уже участвуете!\nКак только игра начнётся, вы получите оповещение!');
        return;
    }else if (StateIs(gameStates.playing)) {
        SendMessage(chatId, 'Игра уже идёт!', GetKeyboard(userInfo.fromId));
        return;
    } else if (!StateIs(gameStates.prePlaying)) {
        SendMessage(chatId, strings.playText, GetKeyboard(userInfo.fromId));
        return;
    }

    if (watchingUsers.indexOf(userInfo.fromId) !== -1) {
        watchingUsers.splice(watchingUsers.indexOf(userInfo.fromId), 1);
    }

    if (playingUsers.length) {
        Transfer(userInfo.forBUsername, config.TransferBotName, currentGamePrice, (err, status) => {
            if (!err) {
                playingUsers.push(userInfo.fromId);
                namesUsersPlaying.push(userInfo.forBUsername);
                bank += +currentGamePrice;
                SendMessage(chatId, 'Вы успешно присоединились к игре.\nКак только игра начнётся, вы получите оповещение!', hideKeyboard);
            } else {
                SendMessage(chatId, 'У вас недостаточно гелиончиков!');
            }
        });
    }
});

bot.onText(/Смотреть/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (!StateIs(gameStates.playing) && !StateIs(gameStates.prePlaying)) {
        SendMessage(chatId, 'Тут не на что смотреть!', GetKeyboard(userInfo.fromId));
        return;
    } else if (watchingUsers.indexOf(userInfo.fromId) !== -1) {
        SendMessage(chatId, 'Вы уже смотрите эту игру!\nКак только что-то произойдёт, вы получите оповещение!');
        return;
    } else if (playingUsers.indexOf(userInfo.fromId) !== -1 || ripUsers.indexOf(userInfo.fromId) !== -1) {
        SendMessage(chatId, 'Вы участник этой игры, поэтому вам не доступна эта функция!');
        return;
    }

    watchingUsers.push(userInfo.fromId);
    SendMessage(chatId, 'Теперь вы смотрите за этой игрой!', GetKeyboard(userInfo.fromId));
});

bot.onText(/Перестать смотреть/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (watchingUsers.indexOf(userInfo.fromId) === -1) {
        SendMessage(chatId, 'Вы и не смотрите за игрой!', GetKeyboard(userInfo.fromId));
        return;
    } else if (playingUsers.indexOf(userInfo.fromId) !== -1 || ripUsers.indexOf(userInfo.fromId) !== -1) {
        SendMessage(chatId, 'Вы участник этой игры, поэтому вам не доступна эта функция!');
        return;
    }

    watchingUsers.splice(watchingUsers.indexOf(userInfo.fromId), 1);
    SendMessage(chatId, 'Вы больше не смотрите эту игрой!', GetKeyboard(userInfo.fromId));
});

bot.onText(/\/start/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    if (StateIs(gameStates.prePlaying)) {
        SendMessage(chatId, `Игра на ${currentGamePrice} гелиончиков скоро начнётся, хочешь присоединиться? Жми "Играть"!`, GetKeyboard(userInfo.fromId));
    } else {
        SendMessage(chatId, strings.playText, GetKeyboard(userInfo.fromId));
    }
    log.info(`${userInfo.username} ${chatId} /start`);
});

bot.onText(/Спустить курок/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (!StateIs(gameStates.playing)) {
        SendMessage(chatId, 'Игра ещё не идёт!', GetKeyboard(userInfo.fromId));
        return;
    } else if (StateIs(gameStates.prePlaying)) {
        SendMessage(chatId, 'Игра ещё не идёт!', hideKeyboard);
        return;
    } else if (playingUsers[currentPlayer] !== userInfo.fromId) {
        SendMessage(chatId, 'Сейчас не ваша очередь!', hideKeyboard);
        return;
    }

    clearTimeout(gameTimeoutId);
    currentBullet++;

    if (currentBullet === bulletIn) {
        setTimeout(() => {
            PlayerLosing(2);
        }, 600);
    } else {

        // todo:: Добавить больше событий

        SendMessage(playingUsers[currentPlayer], 'Вы цел и невредим!', hideKeyboard);
        SendMessageToAll(`@${namesUsersPlaying[currentPlayer]} смахнул капельки пота со лба!`, playingUsers[currentPlayer]);

        GiveWeapon();
    }
});

bot.onText(/Крутануть барабан/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (!StateIs(gameStates.playing)) {
        SendMessage(chatId, 'Игра ещё не идёт!', GetKeyboard(userInfo.fromId));
        return;
    } else if (StateIs(gameStates.prePlaying)) {
        SendMessage(chatId, 'Игра ещё не идёт!', hideKeyboard);
        return;
    } else if (playingUsers[currentPlayer] !== userInfo.fromId) {
        SendMessage(chatId, 'Сейчас не ваша очередь!', hideKeyboard);
        return;
    } else if (scrolledUsers.indexOf(namesUsersPlaying[currentPlayer]) !== -1) {
        SendMessage(chatId, 'Крутануть барабан можно только 1 раз за игру!');
        return;
    }

    scrolledUsers.push(namesUsersPlaying[currentPlayer]);
    ReloadWeapon();

    let fireKeyboard = {
        reply_markup: JSON.stringify({
            keyboard: [
                [`\u{1F52B} Спустить курок \u{26AB}\u{26AB}\u{26AB}\u{26AB}\u{26AB}\u{26AB}`]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        })
    };

    SendMessage(playingUsers[currentPlayer], 'Вы прокрутили барабан!', fireKeyboard);
    SendMessageToAll(`@${namesUsersPlaying[currentPlayer]} прокрутил барабан!`, playingUsers[currentPlayer]);
});

bot.onText(/Баланс/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    GetUserBalance(userInfo.forBUsername, (err, balance) => {
        if (err) {
            log.error('Баланс error: %d', err);
            return false;
        }

        SendMessage(chatId, balance || '0');
    });
});

bot.onText(/Назад/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    if (StateIs(gameStates.prePlaying)) {
        SendMessage(chatId, `Игра на ${currentGamePrice} гелиончиков скоро начнётся, хочешь присоединиться? Жми "Играть"!`, GetKeyboard(userInfo.fromId));
    } else {
        SendMessage(chatId, strings.playText, GetKeyboard(userInfo.fromId));
    }
});

bot.onText(/\/help/, SendHelp );
bot.onText(/Как играть?/, SendHelp );

bot.onText(/Оповещать/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    if (IsSubscriber(userInfo.fromId)) {
        SendMessage(chatId, 'Вы уже подписаны на оповещения!',  GetKeyboard(userInfo.fromId));
        return;
    }

    SubscribersModel.findOne({'fromId': userInfo.fromId}, null, (err, ret) => {
        if (err) {
            log.error('IsSubscriber Error: %d', err);
            return false;
        }
        if (!ret) {
            let subscriber = new SubscribersModel({
                fromId: userInfo.fromId,
                subscribe: true
            });

            subscriber.save(err => {
                if (!err) {
                    log.info(`${userInfo.username}(${userInfo.fromId}) subscribe`);
                    subscribers.push(userInfo.fromId);
                    SendMessage(chatId, 'Теперь вы будете получать уведомления, когда кто-то начнёт игру!', GetKeyboard(userInfo.fromId));
                } else {
                    log.error('Internal error(%d): %s', res.statusCode, err.message);
                }
            });
        } else {
            SubscribersModel.findOneAndUpdate({'fromId': userInfo.fromId}, {'subscribe': true}, {new: false}, (err, ret)  => {
                if (!err) {
                    log.info(`${userInfo.username}(${userInfo.fromId}) subscribe`);
                    subscribers.push(userInfo.fromId);
                    SendMessage(chatId, 'Теперь вы будете получать уведомления, когда кто-то начнёт игру!', GetKeyboard(userInfo.fromId));
                } else {
                    log.error('Internal error(%d): %s', res.statusCode, err.message);
                }
            });
        }
    });
});

bot.onText(/Не оповещать/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    if (!IsSubscriber(userInfo.fromId)) {
        SendMessage(chatId, 'Вы не подписаны на оповещения!',  GetKeyboard(userInfo.fromId));
        return;
    }

    SubscribersModel.findOneAndUpdate({'fromId': userInfo.fromId}, {'subscribe': false}, {new: false}, (err, ret) => {
        if (!err) {
            log.info(`${userInfo.username}(${userInfo.fromId}) unsubscribe`);
            subscribers.splice(subscribers.indexOf(userInfo.fromId), 1);
            SendMessage(chatId, 'Теперь вы не будете получать уведомления, когда кто-то начнёт игру!', GetKeyboard(userInfo.fromId));
        } else {
            log.error('Internal error(%d): %s', res.statusCode, err.message);
        }
    });
});

bot.onText(/Donation/, msg => {
    let chatId = msg.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    SendMessage(chatId, 'О наидобрейший человек, сколько гелеончиков тебе не жалко ?', donateKeyboard);
});


bot.on('text', msg => {
    let text = msg.text ? msg.text.replace(`@${botName}`, '') : null;
    let userInfo = GetUserInfo(msg);

    log.info(`${userInfo.username} say "${text}"`);
});

bot.on('callback_query', msg => {
    let chatId = msg.message.chat.id;
    let userInfo = GetUserInfo(msg);

    if (!isStarted) {
        return;
    } else  if (!isEnabled) {
        SendMessage(chatId, strings.maintenance);
    } else {
        let d = -1;

        switch (msg.data) {
            case 'D10':
                d = 10;
                break;
            case 'D50':
                d = 50;
                break;
            case 'D100':
                d = 100;
                break;
            case 'D500':
                d = 500;
                break;
            case 'D1000':
                d = 1000;
                break;
            default:
                break;
        }

        if (d > 0) {
            Subtract(userInfo.forBUsername, d, (err, status) => {
                if (!err) {
                    SendMessage(chatId, 'Спасибо тебе человек!');
                } else {
                    SendMessage(chatId, 'У вас недостаточно гелиончиков!');
                }
            });
        }
    }
});


/**
 * Send message
 * @method SendMessage
 * @param {Number} chatId
 * @param {String} text
 * @param {{}} keyboard
 */
function SendMessage(chatId, text, keyboard = {}) {
    if (!chatId || !text) {
        log.error(`SendMessage error: chatId or text is null (chatId:${chatId}; text:${text})`);
        return;
    }

    bot.sendMessage(chatId, text, keyboard);
}

/**
 * Send message to all
 * @method SendMessageToAll
 * @param {String} text
 * @param {Number} excludeId
 * @param {{}} keyboard
 */
function SendMessageToAll(text, excludeId, keyboard = {}) {
    if (!text) {
        log.error('SendMessageToAll error: text is null');
        return;
    }

    playingUsers.concat(watchingUsers).forEach(chatId => {
        if (excludeId !== chatId) SendMessage(chatId, text, keyboard);
    });
}

function SendHelp(msg) {
    let chatId = msg.chat.id;

    if (!isStarted){
        return;
    } else if (!isEnabled){
        SendMessage(chatId, strings.maintenance);
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    SendMessage(chatId, strings.helpText);
}


/**
 * Start game
 * @method StartGame
 * @param {Number} money
 */
function StartGame(money) {
    if (StateIs(gameStates.playing)) {
        log.error('StartGame error');
        return;
    }
    log.info('PrePlaying');

    SetState(gameStates.prePlaying);

    currentGamePrice = money;

    if (!config.debug) {
        subscribers.forEach(chatId => {
            if (playingUsers[0] !== chatId) SendMessage(chatId, `Игра на ${money} гелиончиков скоро начнется, у вас есть 1 минута, чтобы присоединиться!`, GetKeyboard(chatId));
        });
    }

    setTimeout(() => {
        if (playingUsers.length >= 2) {
            SetState(gameStates.playing);

            playingUsers.forEach(chatId => {
                SendMessage(chatId, 'Игра начнется через 5 секунд!', hideKeyboard);
            });

            setTimeout(() => {
                log.info(`StartGame ${money}`);
                bank += +money;
                ReloadWeapon();
                GiveWeapon();
            }, 5000);
        } else {
            SetState(gameStates.gameOver);

            Transfer(config.TransferBotName, namesUsersPlaying[0], money, (err, status) => {
                if (err) {
                    log.error(`hel ret error: ${err}\nStatus: ${status}\nMoney: ${money}`);
                    SendMessage(playingUsers[0], 'При возвращение гелиончиков произошла ошибка!!!\nМы обязательно во всём разберёмся и вернём их на родину!', GetKeyboard(playingUsers[0]));
                }
            });

            SendMessageToAll('Игра так и не началась, поэтому вы больше не смотрите за ней!', playingUsers[0], GetKeyboard(playingUsers[0]));
            SendMessage(playingUsers[0], 'К сожалению вас никто не поддержал =(', GetKeyboard(playingUsers[0]));

            ResetGame();
        }
    }, (!config.debug) ? 60000 : 6000);
}

/**
 * Give weapon
 * @method GiveWeapon
 */
function GiveWeapon() {
    currentPlayer++;
    if (currentPlayer >= playingUsers.length) currentPlayer = 0;

    let bulEm = '';
    for (let i = 0; i < 6; i++){
        bulEm += (i <= currentBullet) ? '\u{26AA}' : '\u{26AB}';
    }

    let fireKeyboard = {
        reply_markup: JSON.stringify({
            keyboard: [
                [`\u{1F52B} Спустить курок ${bulEm}`],
                [`Крутануть барабан`]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        })
    };

    if (scrolledUsers.indexOf(namesUsersPlaying[currentPlayer]) !== -1) {
        fireKeyboard = {
            reply_markup: JSON.stringify({
                keyboard: [
                    [`\u{1F52B} Спустить курок ${bulEm}`]
                ],
                resize_keyboard: true,
                one_time_keyboard: true
            })
        };
    }

    SendMessage(playingUsers[currentPlayer], 'Ваш черёд!\nУ вас есть 20 секунд на спуск курка, иначе вы проиграете!', fireKeyboard);
    SendMessageToAll(`Черёд @${namesUsersPlaying[currentPlayer]}, у него есть 20 секунд на ход.`, playingUsers[currentPlayer]);

    gameTimeoutId = setTimeout(() => {
        PlayerLosing(1);
    }, 20000);
}

/**
 * Player losing
 * @method PlayerLosing
 * @param {Number} lType
 */
function PlayerLosing(lType) {
    let curPlayer = playingUsers[currentPlayer];
    let curPlayerName = namesUsersPlaying[currentPlayer];

    watchingUsers.push(playingUsers[currentPlayer]);
    ripUsers.push(namesUsersPlaying[currentPlayer]);
    playingUsers.splice(currentPlayer, 1);
    namesUsersPlaying.splice(currentPlayer, 1);
    if (currentPlayer > 0) currentPlayer--;

    if (lType === 1) {
        SendMessage(curPlayer, 'К сожалению вы проиграли!', hideKeyboard);
        SendMessageToAll(`@${curPlayerName} зассал и не спустил курок!`, curPlayer);
    } else  if (lType === 2) {
        SendMessage(curPlayer, 'К сожалению теперь вы труп!', hideKeyboard);
        SendMessageToAll(`@${curPlayerName} ныне покоится с миром!`, curPlayer);

        ReloadWeapon();
    }

    setTimeout(() => {
        if (playingUsers.length > 1) {
            GiveWeapon();
        } else {
            PlayerWin();
        }
    }, 1000);
}

/**
 * Player win
 * @method PlayerWin
 */
function PlayerWin() {
    SetState(gameStates.gameOver);

    let rip = '';
    ripUsers.forEach(ripUser => {
        rip += `@${ripUser}\n`
    });

    SendMessage(playingUsers[currentPlayer], `Поздравляем с выживанием!\nВы выиграли ${bank}* гелиончиков!\nПомним, любим, скорбим:\n${rip}`, GetKeyboard(playingUsers[currentPlayer]));
    SendMessageToAll(`@${namesUsersPlaying[currentPlayer]} выжил и выиграл ${bank}* гелиончиков!\nПомним, любим, скорбим:\n${rip}`, playingUsers[currentPlayer], GetKeyboard(-1));

    bank = Math.floor(bank * 0.98);

    Transfer(config.TransferBotName, namesUsersPlaying[currentPlayer], bank, (err, status) => {
        if (err) {
            log.error(`ERROR: PlayerWin ${err}\nStatus: ${status}`);
            SendMessage(playingUsers[0], 'При зачислении гелиончиков произошла ошибка!!!\nМы обязательно во всём разберёмся и вернём их на родину!', GetKeyboard(playingUsers[0]));
        }
    });

    ResetGame();
}

/**
 * Reset weapon
 * @method ReloadWeapon
 */
function ReloadWeapon() {
    bulletIn = GetRandomInt(0, 5);
    currentBullet = -1;
}

/**
 * Reset game
 * @method ResetGame
 */
function ResetGame() {
    SetState(gameStates.no);
    currentGamePrice = -1;
    playingUsers = [];
    watchingUsers = [];
    scrolledUsers = [];
    ripUsers = [];
    namesUsersPlaying = [];
    bulletIn = -1;
    currentBullet = -1;
    currentPlayer = -1;
    gameTimeoutId = -1;
    bank = 0;
}


/**
 * Get user info
 * @method GetUserInfo
 * @param {json} msg
 * @return {json} User info
 */
function GetUserInfo(msg) {
    try {
        let fromId = msg.from.id;
        let firstName = (msg.from.first_name) ? msg.from.first_name : '';
        let lastName = (msg.from.last_name) ? msg.from.last_name : '';
        let username = (msg.from.username) ? msg.from.username : `${firstName} ${lastName}`.trim();
        let forBUsername = (msg.from.username) ? msg.from.username : ((lastName) ? lastName : firstName);

        return {
            fromId: fromId,
            firstName: firstName,
            lastName: lastName,
            username: username,
            forBUsername: forBUsername,
        };
    } catch (ex) {
        log.error(`Error GetUserInfo: ${ex}`);
        return null;
    }
}

/**
 * Is subscriber
 * @param {Number} id
 * @return {Boolean} bool
 */
function IsSubscriber(id) {
    return subscribers.indexOf(id) !== -1;
}

/**
 * Update subscribers list
 * @method UpdateSubscribers
 */
function UpdateSubscribers() {
    subscribers = [];
    SubscribersModel.find((err, subs) => {
        if (err) {
            log.error('UpdateSubscribers error(%d): %s', err.statusCode, err.message);
            return;
        }

        subs.forEach(sub => {
            if (sub.subscribe) subscribers.push(sub.fromId);
        });
    });
}


/**
 * State is
 * @method StateIs
 * @param {Number} state
 * @return {Boolean} bool
 */
function StateIs (state) {
    return gameState === state;
}

/**
 * Set state
 * @method SetState
 * @param {Number} state
 */
function SetState (state) {
    gameState = state;
}


/**
 * Get user balance (BAPI)
 * @method GetUserBalance
 * @param {Number} id
 * @param {function} callback(status, balance)
 * @return {callback} (status, balance)
 */
function GetUserBalance(id, callback) {
	request.post(`${config.BorodutchAPIURL}/balance`, {
        form: {
            apiKey: config.BorodutchAPIKey,
            username: id
        },
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    }, (err, response, body) =>{
		if (err) { log.error(err); return callback(err, null); }

        if (body.indexOf('Application Error') !== -1 || JSON.parse(body).status === 500) return callback('Application Error', null);

        return callback(null, JSON.parse(body).balance);
    });
}

/**
 * Transfer (BAPI)
 * @method Transfer
 * @param {String} sender
 * @param {String} receiver
 * @param {Number} number
 * @param {function} callback(status, json)
 * @return {callback} (status, json)
 */
function Transfer(sender, receiver, number, callback) {
    log.info(`Перевод ${number} гелиончиков ${sender} => ${receiver}`);
    if (config.debug) {
        return callback(null, 'body');
    }
	request.post(`${config.BorodutchAPIURL}/transfer`, {
        form: {
            apiKey: config.BorodutchAPIKey,
            sender: sender,
            receiver: receiver,
            number: number,
        },
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    }, (err, response, body) => {
		//log.info('got response');
		if (err) { log.error(err); return callback(err, null); }
		log.info(body);

        if (body.indexOf('Application Error') !== -1) return callback('Application Error', null);
        if (body.indexOf('схерали пытаешься снять больше') !== -1 || body.indexOf('нет такого sender блеать') !== -1 || JSON.parse(body).status === 500) return callback('Недостаточно гелиончиков', null);

        return callback(null, body);
    });
}

/**
 * Subtract (BAPI)
 * @method Subtract
 * @param {String} username
 * @param {Number} number
 * @param {function} callback(status, json)
 * @return {callback} (status, json)
 */
function Subtract(username, number, callback) {
    log.info(`Снятие ${number} гелеончиков у ${username}`);

	request.post(`${config.BorodutchAPIURL}/subtract`, {
        form: {
            apiKey: config.BorodutchAPIKey,
            username: username,
            number: number
        },
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    }, (err, response, body) => {
		if (err) { log.error(err); return callback(err, null); }
        log.info(body); //log.info(JSON.parse(body).balance);

        if (body.indexOf('Application Error') !== -1) return callback('Application Error', null);
        if (body.indexOf('схерали пытаешься снять больше') !== -1 || body.indexOf('нет такого') !== -1 || JSON.parse(body).status === 500) return callback('Недостаточно гелиончиков', null);

        return callback(null, body);
    });
}


/**
 * Is number
 * @method IsNumber
 * @param {Number} n
 * @return {Boolean} bool
 */
function IsNumber (n) {
  return ! isNaN (n-0) && n !== null && n !== '' && n !== false;
}

/**
 * Get random int
 * @method GetRandomInt
 * @param {Number} min
 * @param {Number} max
 * @return {Number} Random number
 */
function GetRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
