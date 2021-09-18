const Imap = require("imap");
const util = require("util");
const EventEmitter = require("events").EventEmitter;
const MailParser = require("mailparser").MailParser;
const fs = require("fs");
const path = require("path");
const async = require("async");

module.exports = MailListener;

function MailListener(options) {
	this.haveNewEmails = false;
	this.parsingUnread = false;
	this.markSeen = !!options.markSeen;
	this.mailbox = options.mailbox || "INBOX";
	if ("string" === typeof options.searchFilter) {
		this.searchFilter = [options.searchFilter];
	} else {
		this.searchFilter = options.searchFilter || ["UNSEEN"];
	}
	this.fetchUnreadOnStart = !!options.fetchUnreadOnStart;

	this.mailParserOptions = options.mailParserOptions || {};
	if (options.attachments && options.attachmentOptions && options.attachmentOptions.stream) {
		this.mailParserOptions.streamAttachments = true;
	}

	this.attachmentOptions = options.attachmentOptions || {};
	this.attachments = options.attachments || false;
	this.attachmentOptions.directory = (this.attachmentOptions.directory ? this.attachmentOptions.directory : "");

	this.imap = new Imap({
		"xoauth2": options.xoauth2,
		"user": options.username,
		"password": options.password,
		"host": options.host,
		"port": options.port,
		"tls": options.tls,
		"tlsOptions": options.tlsOptions || {},
		"connTimeout": options.connTimeout || null,
		"authTimeout": options.authTimeout || null,
		"debug": options.debug || null
	});
	this.imap.once("ready", imapReady.bind(this));
	this.imap.once("close", imapClose.bind(this));
	this.imap.on("error", imapError.bind(this));
}

util.inherits(MailListener, EventEmitter);

MailListener.prototype.start = function() {
	this.imap.connect();
}

MailListener.prototype.stop = function() {
	this.imap.end();
}

function imapReady() {
	let self = this;
	this.imap.openBox(this.mailbox, false, function(err, mailbox) {
		if (err) {
			self.emit("error", err);
		} else {
			self.emit("server:connected");

			let listener = imapMail.bind(self);
			if (self.fetchUnreadOnStart) {
				listener();
			}
			self.imap.on("mail", listener);
			self.imap.on("update", listener);
		}
	});
}

function imapClose() {
	this.emit("server:disconnected");
}

function imapError(err) {
	this.emit("error", err);
}

function imapMail() {
	if (!this.haveNewEmails && !this.parsingUnread) {
		parseUnread.call(this);
		this.parsingUnread = true;
	} else if (this.parsingUnread) {
		this.haveNewEmails = true;
	}
}

function parseUnread() {
	let self = this;
	this.imap.search(self.searchFilter, function(err, results) {
		if (err) {
			self.emit("error", err);
		} else if (results.length > 0) {
			self.imap.setFlags(results, ["\\Seen"], function(err) {
				if (err) {
					self.emit("error", err);
				}
			});

			async.each(results, function(result, callback) {
				let f = self.imap.fetch(result, {
					"bodies": "",
					"markSeen": self.markSeen
				});
				f.on("message", function(msg, seqno) {
					let parser = new MailParser(self.mailParserOptions);
					let attributes = null;
					let emlbuffer = new Buffer("");

					parser.on("end", function(mail) {
						mail.eml = emlbuffer.toString("utf-8");
						if (!self.mailParserOptions.streamAttachments && mail.attachments && self.attachments) {
							async.each(mail.attachments, function(attachment, callback) {
								fs.writeFile(self.attachmentOptions.directory + attachment.generatedFileName, attachment.content, function(err) {
									if (err) {
										self.emit("error", err);

										callback();
									} else {
										attachment.path = path.resolve(self.attachmentOptions.directory + attachment.generatedFileName);
										self.emit("attachment", attachment);

										callback();
									}
								});
							}, function(err) {
								self.emit("mail", mail, seqno, attributes);

								callback();
							});
						} else {
							self.emit("mail", mail, seqno, attributes);

							callback();
						}
					});
					parser.on("attachment", function(attachment) {
						self.emit("attachment", attachment);
					});
					//when all attributes and bodies have been parsed
					let parsingDone = new Promise(function(resolve, reject) {
						msg.on("end", function() {
							resolve();
						});
					});
					msg.on("body", function(stream, info) {
						stream.on("data", function(chunk) {
							emlbuffer = Buffer.concat([emlbuffer, chunk]);
						});
						stream.once("end", function() {
							parsingDone.then(function() {
								parser.write(emlbuffer);
								parser.end();
							}).catch(function(err) {
								self.emit("error", err);
							});
						});
					});
					msg.on("attributes", function(attrs) {
						attributes = attrs;
					});
				});
				f.once("error", function(err) {
					self.emit("error", err);
				});
			}, function(err) {
				if (err) {
					self.emit("error", err);
				}

				if (self.haveNewEmails) {
					self.haveNewEmails = false;

					parseUnread.call(self);
				} else {
					self.parsingUnread = false;
				}
			});
		} else {
			if (self.haveNewEmails) {
				self.haveNewEmails = false;

				parseUnread.call(self);
			} else {
				self.parsingUnread = false;
			}
		}
	});
}
