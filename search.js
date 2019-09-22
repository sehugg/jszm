"use strict";

const G=require("genasync"); // A package I wrote
const JSZM=require("./jszm.js"); // version 2
const readline=require("readline");
const fs=require("fs");
const SortedMap=require('sorted-map');

const In=readline.createInterface({input: process.stdin});
const Out=process.stdout;

const DEBUG=false;

G.defineER(fs,"readFile","readFileG",2);
G.defineER(fs,"writeFile","writeFileG",3);
G.defineR(In,"question","questionG",1);

class DeadError extends Error { }
class NoMoreTurns extends Error { }

class Playthrough {
  constructor() {
    this.turns = [];
  }
  addturn(cmd, toks) {
    this.turns.push({cmd:cmd, toks:toks});
  }
  // TODO: same merge 2x in a row unneccessary
  merge(former, formerdepth, newdepth) {
    var set0 = new Set();
    var set1 = new Set();
    for (var i=0; i<formerdepth; i++) {
      //console.log('SET0',i,former.turns[i]);
      former.turns[i].toks.forEach((value) => { set0.add(value) });
    }
    for (var i=0; i<newdepth; i++) {
      //console.log('SET1',i,this.turns[i]);
      this.turns[i].toks.forEach((value) => { if (set0.has(value)) set1.add(value) });
    }
    return set1;
  }
}

var story=fs.readFileSync(process.argv[2]);
var game=new JSZM(story);

function GameRunner() {

  var vocab;		// vocabulary for game
  var vocabdict = new Set();	// .. in dictionary form
  var maxturns = 50;	// max turns in current game
  var usewords = !true;	// use word output as tokens?
  var wordtoklen = 25;  // truncate phrases to this length
  var usetech = true;	// use vm tech output?
  var usecondtok = true; // use conditional (__) tokens?
  var prob_vocab = 0.5; // probability of a recent vocab word
  var prob_end = 0.5;   // probability of ending the command
  var stablethresh = 5; // token considered stable after this many turns (per turn)

  var numplays = 0;	// # of plays in all games
  var ignorecmds = {}; // no longer used JSON.parse(fs.readFileSync('ignorecmds.json'));
  var playthru;		// current game Playthrough
  var alltokstats = {}; // token -> record
  var stabletoks = new Set();
  var tokfreq = new SortedMap();	// tokens sorted by score

  var playtoks;		// tokens for current game
  var playvocab;	// vocabulary for current game (intersects game vocab)
  var numturns;		// # of turns in current game
  var goaltok;		// current goal token
  var goalrec;		// current token record from 'alltokstats'
  var goalmet;		// 1 = goal met
  
  var turncmd;		// last game command
  var turnscore;	// current turn score
  var turnmods;		// # of VM modifications for current turn
  var turntoks;		// tokens for current turn
  
  function debug(...args) {
    if (DEBUG) console.log.apply(console, args);
  }
  function info(...args) {
    console.log.apply(console, args);
  }

  function addtoken(token) {
    let stat = alltokstats[token];
    // new token? create record
    if (!stat) {
      stat = alltokstats[token] = {
        token: token,
        count: 0,
        goalruns: 0,
        goalsucc: 0,
        first: 99999,
        cmd: turncmd,
        stablecount: 0,
      };
      turnscore += 1;
      info("NEWTOKEN",token,turncmd);
    }
    turntoks.add(stat.token); // string interning
  }  
  function logtoken(token) {
    addtoken(token);
    // log all prior tokens, combined
    if (usecondtok && stabletoks.has(token) && token.startsWith('mv_')) {
      for (var priortok of playtoks) {
        if (stabletoks.has(priortok) && priortok.indexOf(token) < 0 && priortok.startsWith('mv_')) {
          var key = priortok + "__" + token;
          if (!turntoks.has(key)) { addtoken(key); } 
        }
      }
    }
  }
  game.log = (a,b,c) => {
    turnmods += 1;
    if (a == 'pf' || a == 'rand') return; // use as evidence of activity, but don't record
    if (usetech) logtoken(a+"_"+b+"_"+c);
  }
  this.newgame = function() {
    // reset other stuff
    playtoks = new Set();
    playvocab = new Set();
    //playvocab = ['pull','move','rug']; // TODO: CHEATER
    turntoks = new Set();
    turnmods = 0;
    turnscore = 0;
    numturns = -1;
    turncmd = null;
    playthru = new Playthrough();
    // choose a goal token, update statistics
    var goal = tokfreq.slice(0,10);
    goaltok = goal && goal.length && rndchoice(goal).key;
    goalrec = alltokstats[goaltok];
    goalmet = 0;
    if (goalrec) {
      goalrec.goalruns += 1;
      updatetokfreq(goaltok, goalrec);
      debug("GOAL:",goalrec.cmd,goal,goalrec.count,goalrec.first,goaltok);
    }
  }
  function showcommands() {
    info('COMMANDS', playthru.turns.slice(0,numturns+1).map((t) => { return t.cmd }).join(', '));
  }
  function metgoal() {
    if (!goalmet) {
      goalrec.goalsucc += 1;
      debug("Goal success:",goaltok,goalrec.goalsucc,'/',goalrec.goalruns,'turn #',numturns);
      // is this token stable yet?
      var thresh = stablethresh * (goalrec.first+1);
      goalrec.stablecount += 1;
      if (goalrec.stablecount >= thresh && !stabletoks.has(goaltok)) {
        stabletoks.add(goaltok);
        info("STABLE", goaltok);
        showcommands();
      }
      goalmet = 1;
    }
  }
  this.endgame = function() {
    // did we not meet goal?
    if (goaltok && !goalmet) {
      debug("Goal failure:",goaltok,goalrec.goalsucc,'/',goalrec.goalruns);
      goalrec.stablecount = 0;
      stabletoks.delete(goaltok);
    }
  }
  function updatetokfreq(token, stat) {
    if (!stat) stat = alltokstats[token];
    // revisit tokens except those generated by 1st turn
    if (stat.first > 0) {
      tokfreq.set(token, stat.count + stat.goalruns + stat.goalsucc + stat.first);
    } else {
      tokfreq.del(token);
    }
  }
  function committurn(rew) {
    // ignore first turn
    if (numturns < 0)
      turnmods = 0;
    else
      playthru.addturn(turncmd, turntoks);
    // did we hit our goal?
    if (goaltok && turntoks.has(goaltok)) {
      metgoal();
    }
    // ignore command if it did nothing
    if (/*turnmods == 0 || */!turncmd) {
      if (turncmd) {
        //ignorecmds[turncmd] = 1;
        debug("IGNORING", turncmd);
      }
    } else {
      // look at all tokens for this turn
      for (let token of turntoks) {
        let stat = alltokstats[token];
        stat.count += 1;
        // update token in sorted list
        // tokens have priority if they are uncommon and haven't had many goal attempts or successes
        updatetokfreq(token, stat);
        // record best walkthrough
        if (numturns < stat.first) {
          info('REDUCE', token, numturns, '<', stat.first, '(', stat.goalsucc, '/', stat.goalruns, '/', stat.count, ')');
          showcommands();
          // if this is 1st turn, don't bother replaying
          if (numturns == 0) {
            stat.best = null;
          } else {
            stat.best = playthru;
          }
          stat.first = numturns;
          stat.cmd = turncmd;
        }
      }
      // add to playtoks
      for (let token of turntoks) {
        playtoks.add(token);
      }
    }
    // reset for next turn
    turntoks = new Set();
    turnscore = 0;
    turnmods = 0;
    numturns++;
    if (numturns >= maxturns) throw new NoMoreTurns();
  }
  game.print=function*(x) {
    // did we die? abort play
    if (/RESTART, RESTORE, or QUIT/.exec(x)) {
      committurn(-1);
      throw new DeadError();
    }
    // convert to token
    if (usewords) {
      if (x.length >= 3 && !vocabdict.has(x) && !parseInt(x)) {
        let tok = x.substr(0, wordtoklen).trim();
        logtoken(tok);
      }
    }
    // split tokens, see if this is a vocab word
    for (var w of x.split(/[^a-z]/i)) {
      if (w && w.length >= 3 && (w=w.toLowerCase()) && vocabdict.has(w)) playvocab.add(w);
    }
    //console.log("VOCAB",Array.from(playvocab).join(' '));
    // print to console
    if (DEBUG) Out.write(x,"ascii");
  };
  function makevocab() {
    // create word list if not present
    if (!vocab) {
      var keys = game.vocabulary.keys();
      vocab=Array.from(keys).filter((s) => { return /^\w/.exec(s) });
      vocab=vocab.filter((s) => { return !/^(restor|restar|save|q|quit)$/.exec(s) });
      vocab.forEach((w) => { vocabdict.add(w); });
    }
  }
  function rndchoice(list, first, len) {
    if (!first) first = 0;
    if (!len) len = list.length - first;
    var i = Math.floor(first + Math.random() * len);
    return list[i];
  }
  function getrandomcmd() {
    // use recently seen words more often
    var words1 = Array.from(playvocab);
    var words2 = vocab;
    do {
      var s = "";
      for (let i=0; i<2; i++) {
        if (i>0) s += " ";
        // use vocab? recent words first
        if (words1 && Math.random() < prob_vocab)
          s += rndchoice(words1, Math.random()*words1.length);
        else
          s += rndchoice(words2);
        if (Math.random() < prob_end)
          break;
      }
    } while (ignorecmds[s]);
    return s;
  }
  game.read=function*() {
    committurn(1);
    makevocab();
    // if we have a goal, get next command from playthrough
    if (goalrec && goalrec.best && numturns <= goalrec.first) {
      var shuffle = Math.random() < (2+goalrec.first*goalrec.first) / (1+goalrec.goalsucc);
      if (shuffle)
        turncmd = rndchoice(goalrec.best.turns, 0, goalrec.first+1).cmd;
      else
        turncmd = goalrec.best.turns[numturns].cmd;
      debug(turncmd, shuffle?"(shuffle)":"(replay)");
      return turncmd;
    }
    // get totally random command
    turncmd = getrandomcmd();
    debug(turncmd, "(random)");
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
}

var runner = new GameRunner();

function*GrunOne() {
  {
    try {
      runner.newgame();
      yield*game.run();
    } catch(e) {
      if (e instanceof DeadError) {
        //console.log(turncmd,'killed you');
      } else if (e instanceof NoMoreTurns) {
        //
      } else {
        throw e;
      }
    }
    runner.endgame();
  }
  process.nextTick(runOne);
}

function runOne() {
  G.run(GrunOne);
}
process.nextTick(runOne);

