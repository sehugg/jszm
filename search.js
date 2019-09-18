"use strict";

const G=require("genasync"); // A package I wrote
const JSZM=require("./jszm.js"); // version 2
const readline=require("readline");
const fs=require("fs");

const In=readline.createInterface({input: process.stdin});
const Out=process.stdout;

G.defineER(fs,"readFile","readFileG",2);
G.defineER(fs,"writeFile","writeFileG",3);
G.defineR(In,"question","questionG",1);

class DeadError extends Error { }

G.run((function*() {
  var story=yield fs.readFileG(process.argv[2],{});
  var game=new JSZM(story);
  var vocab;
  var vocabdict = {};
  var turncmd = '__START__';
  var turnscore;
  var turnmods;
  var turntoks;
  var playtoks;
  var playindex;
  var allcmdstats = {};
  var alltokstats = {};
  var ignorecmds = JSON.parse(fs.readFileSync('ignorecmds.json'));
  var rankedcmds;
  
  function logtoken(token) {
    turntoks[token] = 1;
  }
  function newgame() {
    // sort commands by rank (best first)
    rankedcmds = []
    for (var cmd in allcmdstats) {
      rankedcmds.push(allcmdstats[cmd]);
    }
    rankedcmds.sort((a,b) => { return b.score-a.score });
    playtoks = new Set();
    turntoks = {};
    turnmods = 0;
    turnscore = 0;
    playindex = 0;
  }
  function getrandomcmd() {
    do {
      var s = "";
      for (var i=0; i<2; i++) {
        if (i>0) s += " ";
        s += vocab[Math.floor(Math.random() * vocab.length)];
        if (Math.random() < 0.5) break;
      }
    } while (ignorecmds[s]);
    return s;
  }
  function committurn(rew) {
    playindex++;
    // ignore command if it did nothing
    if (turnmods == 0) {
      ignorecmds[turncmd] = 1;
    } else {
      var thiscmdstats = allcmdstats[turncmd];
      if (!thiscmdstats)
        thiscmdstats = allcmdstats[turncmd] = {cmd:turncmd,toks:turntoks,score:0};
      for (var token in turntoks) {
        // new token?
        var stat = alltokstats[token];
        if (!stat) {
          stat = alltokstats[token] = {
            count: 0,
            first: 99999,
            cmd: turncmd,
          };
          turnscore += 1;
        }
        stat.count += 1;
        if (playindex < stat.first) {
          stat.first = playindex;
          stat.cmd = turncmd;
          console.log(token, playtoks.size, stat);
          playtoks.forEach((pt) => {
            //console.log(pt, alltokstats[pt]);
            alltokstats[pt].next = token;
          });
        }
        stat.cmd = turncmd;
        //if (stat.count < 100) console.log(token, stat);
        // new token for this cmd?
        if (!thiscmdstats.toks[token]) {
          thiscmdstats.toks[token] = 1;
          turnscore += 1;
        }
      }
      thiscmdstats.score += turnscore;
      console.log(turncmd,'+',turnscore,'=',thiscmdstats.score);
      // add to playtoks
      for (var token in turntoks) {
        playtoks.add(token);
      }
    }
    turntoks = {};
    turnscore = 0;
    turnmods = 0;
  }
  game.log = (a,b,c) => {
    logtoken(a+"_"+b+"_"+c);
    turnmods += 1;
    //console.log(a,b,c)
  }
  game.print=function*(x) {
    if (/RESTART, RESTORE, or QUIT/.exec(x)) {
      committurn(-1);
      throw new DeadError();
    }
    for (var tok of x.split(/\s+/)) {
      if (tok.length >= 3 && !vocabdict[tok] && !parseInt(tok)) {
        logtoken(tok);
      }
    }
    Out.write(x,"ascii");
  };
  function makevocab() {
    // create word list if not present
    if (!vocab) {
      var keys = game.vocabulary.keys();
      vocab=Array.from(keys).filter((s) => { return /^\w/.exec(s) });
      vocab=vocab.filter((s) => { return !/^(restor|restar|save|q|quit)$/.exec(s) });
      vocab.forEach((w) => { vocabdict[w]=1; });
    }
  }
  game.read=function*() {
    committurn(1);
    makevocab();
    // get next command
    if (rankedcmds.length && Math.random() < 0.5) {
      // figure out next token based on prior
      /*
      var score = 99999;
      playtoks.forEach((tok) => {
        var stats = alltokstats[tok];
        if (stats.next) {
          var next = alltokstats[stats.next];
          console.log('+++', tok, alltokstats[tok], next.cmd);
        }
      });
      */
      var i = Math.floor(Math.pow(Math.random(), 4) * rankedcmds.length);
      turncmd = rankedcmds[i].cmd;
      console.log(turncmd, '-> score', rankedcmds[i].score, '#', i);
    } else {
      turncmd = getrandomcmd();
      console.log(turncmd);
    }
    return turncmd;
    //return yield In.questionG("");
  };
  game.save=function*(x) {
    var n,e;
    Out.write("Save? ","ascii");
    n=yield In.questionG("");
    if(!n) return false;
    try {
      yield fs.writeFileG(n,new Buffer(x.buffer),{});
      return true;
    } catch(e) {
      return false;
    }
  };
  game.restore=function*() {
    var n,e;
    Out.write("Restore? ","ascii");
    n=yield In.questionG("");
    if(!n) return null;
    try {
      return new Uint8Array(yield fs.readFileG(n,{}));
    } catch(e) {
      return null;
    }
  };
  while (1) {
    try {
      newgame();
      yield*game.run();
    } catch(e) {
      if (e instanceof DeadError) {
        console.log(turncmd,'killed you');
        delete allcmdstats[turncmd]; // TODO?
        if (0) {
          fs.writeFileSync('ignorecmds.json.tmp',JSON.stringify(ignorecmds));
          fs.renameSync('ignorecmds.json.tmp', 'ignorecmds.json');
        }
      } else
        throw e;
    }
  }
  process.exit(0);
})());