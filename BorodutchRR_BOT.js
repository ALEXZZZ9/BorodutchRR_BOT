'use strict'

/*
start - About
help - Help
subscribe - Subscribe
unsubscribe - Unsubscribe
*/

const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const request = require('request');

const log = require('./libs/log')(module);
const config = require('./config.json');
const SubscribersModel = require('./models/subscribers').SubscribersModel;

const options = {
    polling: {timeout: 10, interval: 1000}
};

var isEnabled = true;
var isStarted = false;

var token = /*process.env.TELEGRAM_BOT_TOKEN || */config.TELEGRAM_BOT_TOKEN;
var botName = '';

var isPrePlaying = false;
var isPlaying = false;
var subscribers = [];

var playingUsers = [];
var watchingUsers = [];
var scrolledUsers = [];
var ripUsers = [];
var namesUsersPlaying = [];

var currentGamePrice = 0;
var bulletIn = -1;
var currentBullet = -1;
var currentPlayer = -1;
var gameTimeoutId = -1;
var bank = 0;

var mainMenuKeyboard = {
    reply_markup: JSON.stringify({
        keyboard: [
            ['Играть 50', 'Играть 100'],
            ['\u{1F4B0} Баланс \u{1F4B0}', '\u{1F4B8} Donation \u{1F4B8}'],
            ['/subscribe \u{1F509}', '/unsubscribe \u{1F507}']
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    })
};
var gameKeyboard = {
    reply_markup: JSON.stringify({
        keyboard: [
            ['Играть', 'Назад'],
            ['\u{1F4B0} Баланс \u{1F4B0}', '\u{1F4B8} Donation \u{1F4B8}'],
            ['/subscribe \u{1F509}', '/unsubscribe \u{1F507}']
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    })
};
var donateKeyboard = {
    reply_markup: JSON.stringify({
        inline_keyboard: [
            [{text: '10', callback_data: 'D10'}, {text: '50', callback_data: 'D50'}],
            [{text: '100', callback_data: 'D100'}, {text: '500', callback_data: 'D500'}],
            [{text: '1000', callback_data: 'D1000'}],
        ]
    })
};
var hideKeyboard = {
    reply_markup: JSON.stringify({
        keyboard: [],
        hide_keyboard: true
    })
};


var bot = new TelegramBot(token, options);

mongoose.connect(config.mongoose.uri);
var db = mongoose.connection;

db.on('error', err => {
    log.error('connection error:', err.message);
});
db.once('open', () => {
    log.info('Connected to DB!');
});


bot.getMe().then(me => {
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
    var chatId = msg.chat.id;
    //var userInfo = GetUserInfo(msg);

    if (!isStarted || chatId !== config.admins[0]){
        return;
    }

    isEnabled = true;

    SendMessage(chatId, `Bot Enabled`);
});

bot.onText(/\/disable/, msg => {
    var chatId = msg.chat.id;
    //var userInfo = GetUserInfo(msg);

    if (!isStarted || chatId !== config.admins[0]){
        return;
    }

    isEnabled = false;
    SendMessage(chatId, `Bot Disabled`);
});

bot.onText(/Играть (.+)/, (msg, match) => {
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (isPlaying) {
        SendMessage(chatId, 'Игра уже идёт!');
        return;
    } else if (playingUsers.indexOf(userInfo.fromId) !== -1) {
        SendMessage(chatId, 'Вы уже участвуете!\nКак толька игра начнётся вы получите оповещение!', hideKeyboard);
        return;
    } else if (isPrePlaying) {
        SendMessage(chatId, `Игра на ${currentGamePrice} гелиончиков скоро начнётся, хочешь присоединится нажми "Играть"!`, gameKeyboard);
        return;
    }


    if (!IsNumber(match[1])) {
        SendMessage(chatId, 'Введите корректную сумму!', mainMenuKeyboard);
        return;
    } else if (match[1] < 10) {
        SendMessage(chatId, 'Нельзя играть меньше чем на 10 гелиончиков!', mainMenuKeyboard);
        return;
    } else if (match[1] > 10000) {
        SendMessage(chatId, 'Нельзя играть больше чем на 10000 гелиончиков!', mainMenuKeyboard);
        return;
    }

    Transfer(userInfo.forBUsername, config.TransferBotName, match[1], (err, status) => {
        if (!err) {
            SendMessage(chatId, 'У других игроков есть 1 минута, чтобы присоединиться к этой игре!\nИгра начнётся через 1 минуту если к вам присоединится хотя бы 1 человек!', hideKeyboard);
            playingUsers.push(userInfo.fromId);
            namesUsersPlaying.push(userInfo.forBUsername);
            StartGame(match[1]);
        } else {
            SendMessage(chatId, 'У вас недостаточно гелиончиков!', mainMenuKeyboard);
        }
    });
});

bot.onText(/Играть$/, msg => {
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (isPlaying) {
        SendMessage(chatId, 'Игра уже идёт!');
        return;
    } else if (!isPrePlaying) {
        SendMessage(chatId, 'Чтобы начать игру, нажмите "Играть 50/100" или напишите боту "Играть {сумма на которую вы хотите играть}"', mainMenuKeyboard);
        return;
    } else if (playingUsers.indexOf(userInfo.fromId) !== -1) {
        SendMessage(chatId, 'Вы уже Участвуете!\nКак толька игра начнётся вы получите оповещение  !');
        return;
    }

    if (playingUsers.length) {
        Transfer(userInfo.forBUsername, config.TransferBotName, currentGamePrice, (err, status) => {
            if (!err) {
                SendMessage(chatId, 'Вы успешно присоединились к игре.\nКак толька игра начнётся вы получите оповещение!', hideKeyboard);
                playingUsers.push(userInfo.fromId);
                namesUsersPlaying.push(userInfo.forBUsername);
                bank += +currentGamePrice;
            } else {
                SendMessage(chatId, 'У вас недостаточно гелиончиков!');
            }
        });
    }
});

bot.onText(/\/start/, msg => {
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    //SendMessage(chatId, '(Это бета тест!!! Нет никакой гарантии что с вашими гелеончиками ничего не случится!)');

    if (isPrePlaying) {
        SendMessage(chatId, `Игра на ${currentGamePrice} гелиончиков скоро начнётся, хочешь присоединится нажми "Играть"!`, gameKeyboard);
    } else {
        SendMessage(chatId, 'Чтобы начать игру, нажмите "Играть 50/100" или напишите боту "Играть {сумма на которую вы хотите играть}\n*С каждого выигрыша 2% комиссия!', mainMenuKeyboard);
    }
    log.info(`${userInfo.username} ${chatId} /start`);
});

bot.onText(/Спустить курок/, msg => {
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (!isPlaying) {
        SendMessage(chatId, 'Игра ещё не идёт!', mainMenuKeyboard);
        return;
    } else if (isPrePlaying) {
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
        SendMessage(playingUsers[currentPlayer], 'Вы цел и невредим!', hideKeyboard);
        SendMessageToAll(`@${namesUsersPlaying[currentPlayer]} смахнул капельки пота со лба!`, playingUsers[currentPlayer]);

        GiveWeapon();
    }
});

bot.onText(/Крутануть барабан/, msg => {
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    } else if (!isPlaying) {
        SendMessage(chatId, 'Игра ещё не идёт!', mainMenuKeyboard);
        return;
    } else if (isPrePlaying) {
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
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    GetUserBalance(userInfo.forBUsername, (err, balance) => {
        if (err) {
            log.error('Баланс Error: %d', err);
            return false;
        }

        SendMessage(chatId, balance);
    });
});

bot.onText(/Назад/, msg => {
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    SendMessage(chatId, 'Чтобы начать игру, нажмите "Играть 50/100" или напишите боту "Играть {сумма на которую вы хотите играть}"', mainMenuKeyboard);
});

bot.onText(/\/help/, msg => {
    var chatId = msg.chat.id;

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    SendMessage(chatId, 'Чтобы начать игру, нажмите "Играть 50/100" или напишите боту "Играть {сумма на которую вы хотите играть}"\nИспользуется шестизарядный револьвер.\nИгра длится пока не останется 1 выживший!');
});

bot.onText(/\/subscribe/, msg => {
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    if (IsSubscriber(userInfo.fromId)) {
        SendMessage(chatId, 'Вы уже подписаны на оповещения!');
        return;
    }

    SubscribersModel.findOne({'fromId': userInfo.fromId}, null, (err, ret) => {
        if (err) {
            log.error('IsSubscriber Error: %d', err);
            return false;
        }
        if (!ret) {
            var subscriber = new SubscribersModel({
                fromId: userInfo.fromId,
                subscribe: true
            });

            subscriber.save(err => {
                if (!err) {
                    log.info(`${userInfo.username}(${userInfo.fromId}) subscribe`);
                    SendMessage(chatId, 'Теперь вы будете получать уведомления когда кто то начнёт игру!');
                    subscribers.push(userInfo.fromId);
                } else {
                    log.error('Internal error(%d): %s', res.statusCode, err.message);
                    //SendMessage(chatId, 'Error');
                }
            });
        } else {
            SubscribersModel.findOneAndUpdate({'fromId': userInfo.fromId}, {'subscribe': true}, {new: false}, (err, ret)  => {
                if (!err) {
                    log.info(`${userInfo.username}(${userInfo.fromId}) subscribe`);
                    SendMessage(chatId, 'Теперь вы будете получать уведомления когда кто то начнёт игру!');
                    subscribers.push(userInfo.fromId);
                } else {
                    log.error('Internal error(%d): %s', res.statusCode, err.message);
                    //SendMessage(chatId, 'Error');
                }
            });
        }
    });
});

bot.onText(/\/unsubscribe/, msg => {
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    if (!IsSubscriber(userInfo.fromId)) {
        SendMessage(chatId, 'Вы не подписаны на оповещения!');
        return;
    }

    SubscribersModel.findOneAndUpdate({'fromId': userInfo.fromId}, {'subscribe': false}, {new: false}, (err, ret) => {
        if (!err) {
            log.info(`${userInfo.username}(${userInfo.fromId}) unsubscribe`);
            SendMessage(chatId, 'Теперь вы не будете получать уведомления когда кто то начнёт игру!');
            subscribers.splice(subscribers.indexOf(userInfo.fromId), 1);
        } else {
            log.error('Internal error(%d): %s', res.statusCode, err.message);
            //SendMessage(chatId, 'Error');
        }
    });
});

bot.onText(/Donation/, msg => {
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted){
        return;
    } else  if (!isEnabled){
        SendMessage(chatId, 'Бот на техобслуживании!');
        return;
    } else if (msg.chat.type === 'group') {
        return;
    }

    SendMessage(chatId, 'О наидобрейший человек, сколько гелеончиков тебе не жалко ?', donateKeyboard);
});


bot.on('text', msg => {
    var text = msg.text ? msg.text.replace(`@${botName}`, '') : null;
    var chatId = msg.chat.id;
    var userInfo = GetUserInfo(msg);

    log.info(`${userInfo.username} say "${text}"`);
});

bot.on('callback_query', msg => {
    var chatId = msg.message.chat.id;
    var userInfo = GetUserInfo(msg);

    if (!isStarted) {
        return;
    } else  if (!isEnabled) {
        SendMessage(chatId, 'Бот на техобслуживании!');
    } else {

        var d = -1;

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
        log.error('SendMessageToAll error: chatId or text is null');
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

    playingUsers.forEach(chatId => {
        if (excludeId !== chatId) SendMessage(chatId, text, keyboard);
    });
    watchingUsers.forEach(chatId => {
        SendMessage(chatId, text, keyboard);
    });
}


/**
 * Start game
 * @method StartGame
 * @param {Number} money
 */
function StartGame(money) {
    if (isPlaying) {
        log.error('StartGame error');
        return;
    }
    log.info('PrePlaying');

    isPrePlaying = true;
    currentGamePrice = money;

    if (!config.debug) {
        subscribers.forEach(chatId => {
            if (playingUsers[0] !== chatId) SendMessage(chatId, `Игра на ${money} гелиончиков скоро начнется, у вас есть 1 минута чтобы присоединиться!`, gameKeyboard);
        });
    }

    setTimeout(() => {
        if (playingUsers.length >= 2) {
            isPlaying = true;
            isPrePlaying = false;

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
            Transfer(config.TransferBotName, namesUsersPlaying[0], money, (err, status) => {
                if (err) {
                    log.error(`hel ret error: ${err}\nStatus: ${status}\nMoney: ${money}`);
                    SendMessage(playingUsers[0], 'При возвращение гелиончиков произошла ошибка!!!\nМы обязательно во всём разберёмся и вернём их на родину!', mainMenuKeyboard);
                }
            });

            SendMessage(playingUsers[0], 'К сожалению вас никто не поддержал =(', mainMenuKeyboard);
            ResetGame();
        }
    }, (!config.debug) ? 60000 : 6000);//60000
}

/**
 * Give weapon
 * @method GiveWeapon
 */
function GiveWeapon() {
    currentPlayer++;
    if (currentPlayer >= playingUsers.length) currentPlayer = 0;

    let bulEm = '';
    for (var i = 0; i < 6; i++){
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

    SendMessage(playingUsers[currentPlayer], 'Ваш черёд !\nУ вас есть 20 секунд на спуск курка иначе вы проиграете!', fireKeyboard);
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
    if (lType === 1) {
        SendMessage(playingUsers[currentPlayer], 'К сожалению вы проиграли!', hideKeyboard);
        SendMessageToAll(`@${namesUsersPlaying[currentPlayer]} зассал и не спустил курок!`, playingUsers[currentPlayer]);
    } else  if (lType === 2) {
        SendMessage(playingUsers[currentPlayer], 'К сожалению теперь вы труп!', hideKeyboard);
        SendMessageToAll(`@${namesUsersPlaying[currentPlayer]} ныне покоится с миром!`, playingUsers[currentPlayer]);

        ReloadWeapon();
    }

    watchingUsers.push(playingUsers[currentPlayer]);
    ripUsers.push(namesUsersPlaying[currentPlayer]);
    playingUsers.splice(currentPlayer, 1);
    namesUsersPlaying.splice(currentPlayer, 1);
    if (currentPlayer > 0) currentPlayer--;

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
    var rip = '';
    ripUsers.forEach(ripUser => {
        rip += `@${ripUser}\n`
    });

    SendMessage(playingUsers[currentPlayer], `Поздравляем с выживанием!\nВы выиграли ${bank}* гелиончиков!\nПомним, любим, скорбим:\n${rip}`, mainMenuKeyboard);
    SendMessageToAll(`@${namesUsersPlaying[currentPlayer]} выжил и выиграл ${bank}* гелиончиков!\nПомним, любим, скорбим:\n${rip}`, playingUsers[currentPlayer], mainMenuKeyboard);

    bank = Math.floor(bank * 0.98);

    Transfer(config.TransferBotName, namesUsersPlaying[currentPlayer], bank, (err, status) => {
        if (err) {
            log.error(`ERROR: PlayerWin ${err}\nStatus: ${status}`);
            SendMessage(playingUsers[0], 'При зачислении гелиончиков произошла ошибка!!!\nМы обязательно во всём разберёмся и вернём их на родину!', mainMenuKeyboard);
        }
        //log.info(status);
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
    isPlaying = false;
    isPrePlaying = false;
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
        var fromId = msg.from.id;
        var firstName = (msg.from.first_name) ? msg.from.first_name : '';
        var lastName = (msg.from.last_name) ? msg.from.last_name : '';
        var username = (msg.from.username) ? msg.from.username : `${firstName} ${lastName}`.trim();
        var forBUsername = (msg.from.username) ? msg.from.username : ((lastName) ? lastName : firstName);

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
