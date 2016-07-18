const mongoose = require('mongoose');

const Schema = mongoose.Schema;

/**
 * Subscribers Schema
 */
const SubscribersSchema = new Schema({
    fromId: { type: Number, required: true },
    subscribe: { type: Boolean, default: false }
});


var SubscribersModel = mongoose.model('subscribers', SubscribersSchema);

module.exports.SubscribersModel = SubscribersModel;
