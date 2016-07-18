var winston = require('winston');

var isWin = /^win/.test(process.platform);

function getLogger(module) {
    var path = module.filename.split(isWin ? '\\' : '/').slice(-2).join(isWin ? '\\' : '/');

    return new winston.Logger({
        transports : [
            new winston.transports.Console({
                colorize: true,
                level: 'debug',
                label: path
            }),
            new winston.transports.File({
                filename: 'log.log'
            })
        ]
    });
}

module.exports = getLogger;
