
// var D;

var fs = require('fs');
var path = require('path');
var url = require('url');
var events = require('events');
var async = require('async');
var glob = require('glob');
var _ = require('underscore');
var markdom = require('markdom');
var watch = require('watch');
var bcrypt = require('bcrypt');
var datetime = require('datetime');
var abind = require('dandy/errors').abind;
var ibind = require('dandy/errors').ibind;
var NerveAPI = require('./NerveAPI').NerveAPI;
var Post = require('./Post').Post;
var NerveTransformer = require('./NerveTransformer').NerveTransformer;
var RSSTransformer = require('./RSSTransformer').RSSTransformer;
var PostSummarizer = require('./PostSummarizer').PostSummarizer;
var appjs = require('app.js');
var Raw = require('markdom').nodeTypes.Raw;

// *************************************************************************************************

var rePostFileName = /(\d{4})-(\d{2})-(\d{2}).(md|markdown)/;
var defaultApiPath = '/api';
var defaultTimeZone = 'PST';
var postIndex = 0;
var imagesDirName = 'images';
var htmlMimeType = 'text/html';

// *************************************************************************************************

function Blog(conf, cb) {
    events.EventEmitter.call(this);

    this.datedPosts = [];
    this.groupedPosts = {};
    this.transforms = [];
    this.isInvalid = true;
    
    this.title = '';    
    this.description = '';

    this._assignConf(conf);

    this.reload = aggregate(this.reload);
}

exports.Blog = Blog;

function subclass(cls, supercls, proto) {
    cls.super_ = supercls;
    cls.prototype = Object.create(supercls.prototype, {
        constructor: {value: cls, enumerable: false}
    });
    _.extend(cls.prototype, proto);
}

subclass(Blog, events.EventEmitter, {
    setPassword: function(password) {
        if (this.passwordPath) {
            var salt = bcrypt.gen_salt_sync(10);
            this.password = bcrypt.encrypt_sync(password, salt);
            fs.writeFileSync(this.passwordPath, this.password);
        }
    },

    checkPassword: function(password, cb) {
        async.waterfall([
            ibind(function(next) {
                this._findContent(next);
            }, cb, this),

            ibind(function(next) {
                if (this.contentPaths.length && !this.passwordPath) {
                    this.passwordPath = path.join(this.contentPaths[0].path, '.nervepass');
                    fs.readFile(this.passwordPath, _.bind(function(err, data) {
                        if (!err) {
                            this.password = (data+'').trim();
                        }
                        next(err);
                    }, this));
                } else {
                    next(0);
                }
            }, cb, this),

            ibind(function(next) {
                if (this.password && password) {
                    var passed = bcrypt.compareSync(password, this.password);
                    next(0, passed);
                } else {
                    next(0, false);
                }
            }, cb, this)
        ], cb);
    },

    monitorAll: function(cb) {
        this._findContent(abind(function(err) {
            async.map(this.contentPaths, ibind(function(item, cb2) {
                this.monitor(item.path, cb2);
            }, cb, this), ibind(function(err) {
                if (err) {
                    // XXXjoe Need to rollback monitors here
                } else {
                    this.isMonitoring = true;                
                }
                if (cb) cb(err);
            }, cb, this));
        }, cb, this))
    },

    monitor: function(contentPath, cb) {
        watch.createMonitor(contentPath, {interval: 100}, _.bind(function(monitor) {
            monitor.on("created", _.bind(function(f, stat) {
                D&&D('Created', f);
                this.invalidate();
            }, this))
            monitor.on("changed", _.bind(function(f, stat, prev) {
                if (stat.mtime.getTime() != prev.mtime.getTime()) {
                    D&&D('Changed', f);
                    this.invalidate();
                }
            }, this));
            monitor.on("removed", _.bind(function(f, stat) {
                D&&D('Removed', f);
                this.invalidate();
            }, this));

            if (cb) cb(0);
        }, this));
    },
    
    invalidate: function() {
        this.isInvalid = true;

        // This is a workaround for a quirk on my EC2 instance where Dropbox deletes
        // files momentarily while syncing changes, but watch only reports the removal
        // but not the file being recreated.  So, we have to wait an arbitrary amount
        // to be sure the file is restored before reloading again.
        setTimeout(_.bind(function() {
            this.reload();
        }, this), 50);
    },

    useApp: function(app, cb) {
        this.app = app;
        if (app) {
            if (this.searchPaths) {
                this.app.paths.push.apply(this.app.paths, this.searchPaths);                
            }

            this.reload(cb);
        }        
    },

    reload: function(cb) {
        if (!this.isInvalid) {
            if (cb) cb(0);
            return;
        }

        var firstLoad = !this.posts;
        var postMap = {};

        if (this.posts) {
            this.posts.forEach(function(post) {
               if (post.path in postMap) {
                    postMap[post.path].push(post);
                } else {
                    postMap[post.path] = [post];
                }
            });
        }

        var newPosts = [];
        var events = [];

        this.statPosts(abind(function(err, statMap) {
            var remaining = _.keys(statMap).length;
            if (!remaining) {
                complete.apply(this);
            }

            _.each(statMap, ibind(function(mtime, filePath) {
                if (!postMap[filePath]) {
                    this._parsePostsFile(filePath, abind(function(err, posts) {
                        newPosts.push.apply(newPosts, posts);

                        if (!firstLoad) {
                            posts.forEach(ibind(function(post) {
                                D&&D('post created', post.title);

                                events.push({event: 'postCreated', post: post});
                            }, cb, this));
                        }
                        next.apply(this);
                    }, cb, this));
                } else {
                    var previousPosts = postMap[filePath];
                    var previousPost = previousPosts[0];
                    if (mtime > previousPost.mtime) {
                        this._parsePostsFile(filePath, abind( function(err, posts) {
                            newPosts.push.apply(newPosts, posts);

                            _.each(posts, ibind(function(post, index) {
                                var existingPost = _.detect(previousPosts, function(oldPost) {
                                    return oldPost.url == post.url;
                                });
                                if (existingPost) {
                                    var index = previousPosts.indexOf(existingPost);
                                    previousPosts.splice(index, 1);
                                    if (!this._postsAreEqual(post, existingPost)) {
                                        D&&D('post changed', post.title);
                                        events.push({name: 'postChanged', post: post});
                                    }
                                } else {
                                    D&&D('post created', post.title);
                                    events.push({name: 'postCreated', post: post});
                                }
                            }, cb, this));

                            // Delete posts that have been removed from their file
                            _.each(previousPosts, ibind(function(oldPost) {
                                D&&D('post deleted', oldPost.title);
                                events.push({name: 'postDeleted', post: oldPost});
                            }, cb, this));
    
                            delete postMap[filePath];
                            next.apply(this);
                        }, cb, this));
                    } else {
                        newPosts.push.apply(newPosts, previousPosts);
                        delete postMap[filePath];
                        next.apply(this);
                    }
                }
           }, cb, this));

           function next() {
               if (!--remaining) {
                   complete.apply(this);
               }
           }

           function complete() {
                // Delete posts in files that have been deleted
                _.each(postMap, ibind(function(posts, path) {
                    _.each(posts, ibind(function(oldPost) {
                        D&&D('post deleted', oldPost.title);
                        events.push({name: 'postDeleted', post: oldPost});
                    }, cb, this));
               }, cb, this));

               this._assignPosts(newPosts);

               _.each(events, _.bind(function(event) {
                   this.emit(event.name, event.post);
                   this.onPostModified(event.post);
               }, this));

               if (!this.isMonitoring) {
                   this.monitorAll(cb);
               } else {
                   cb(0);
               }
           }
        }, cb, this));
    },

    normalizeImageURL: function(baseURL) {
        return this.normalizeURL('/content/images/' + baseURL);
    },                      

    normalizeURL: function(URL, type) {
        if (this.app) {
            return this.app.normalizeURL(URL, type);
        } else {
            return URL;
        }
    },

    onPostModified: function(post) {
        if (this.cache) {
            if (post.isChronological) {
                // D&&D('+ before', require('util').inspect(post, false, 100));
                this.cache.remove('/');
                this.cache.remove('/' + post.url);
                this.cache.remove('/api/post/' + post.url);
                this.cache.removeAll('/api/page');
                this.cache.removeAll('/api/posts');
                this.cache.removeAll('/index.xml');
                // D&&D(' - after', require('util').inspect(post, false, 100));
            } else {
                if (post.group == 'drafts') {
                    this.cache.remove('/drafts');
                    this.cache.remove('/api/group/drafts');
                } else {
                    this.cache.removeAll(post.url);
                }
            }
        }
    },

    statPosts: function(cb) {
        var blog = this;
        var statMap = {};
        var remaining = 1;
        statFiles(this.contentPattern);

        function statFiles(contentPattern) {
            var paths;

            async.waterfall([
                function(next) {
                    glob(contentPattern, next);
                },
                function(matches, next) {
                    paths = matches;

                    async.map(paths, function(aPath, cb2) {
                        fs.lstat(aPath, cb2);
                    }, next);
                },
                function(stats, next) {
                    _.each(stats, function(stat, i) {
                        if (stat.isDirectory()) {
                            ++remaining
                            statFiles(contentPattern + '/*');
                        } else {
                            statMap[paths[i]] = stat.mtime;
                        }
                    });

                    if (!--remaining) {
                        cb(0, statMap);
                    }
                }
            ]);
        }
    },
     
    getAllPosts: function(render, cb) {
        if (typeof(render) == 'function') { cb = render; render = false; }

        if (this.isInvalid) {
            this.reload(abind(function() {
                this._returnPosts(this.datedPosts, render, cb);
            }, cb, this));
        } else {
            this._returnPosts(this.datedPosts, render, cb);
        }
    },

    getAllGroupedPosts: function(render, cb) {
        if (typeof(render) == 'function') { cb = render; render = false; }

        if (this.isInvalid) {
            this.reload(abind(function() {
                cb(0, this.groupedPosts);
            }, cb, this));
        } else {
            cb(0, this.groupedPosts);
        }
    },
    
    getPostsByPage: function(pageNum, pageSize, render, cb) {
        if (typeof(render) == 'function') { cb = render; render = false; }

        this.getAllPosts(_.bind(function(err, allPosts) {
            if (err) return cb ? cb(err): 0;
            
            var startIndex = pageNum*pageSize;
            var posts = allPosts.slice(startIndex, startIndex+pageSize);

            return this._returnPosts(posts, render, cb);
        }, this));
    },
    
    getPostsByDay: function(year, month, day, render, cb) {
        if (typeof(render) == 'function') { cb = render; render = false; }

        this.getAllPosts(_.bind(function(err, allPosts) {
            if (err) return cb ? cb(err) : 0;

            var target = [year, month, day].join('-');
            var posts = _.select(allPosts, function(post) {
                return datetime.format(post.date, '%Y-%m-%d') == target;
            });

            return this._returnPosts(posts, render, cb);
        }, this));
    },
    
    getPost: function(slug, year, month, day, render, cb) {
        if (typeof(render) == 'function') { cb = render; render = false; }

        this.getPostsByDay(year, month, day, _.bind(function(err, allPosts) {
            if (err) return cb ? cb(err) : 0;

            var posts = _.select(allPosts, function(post) {
                return post.slug == slug;
            });

            return this._returnPosts(posts, render, cb);
        }, this));
    },
    
    getPostsByGroup: function(groupName, render, cb) {
        if (typeof(render) == 'function') { cb = render; render = false; }

        this.getAllGroupedPosts(_.bind(function(err, groupedPosts) {
            if (err) return cb ? cb(err) : 0;

            var posts = groupedPosts[groupName] || [];
            return this._returnPosts(posts, render, cb);
        }, this));
    },

    addTransform: function(transform) {
        this.transforms.push(transform);
    },

    matchTransform: function(URL) {
        var U = url.parse(URL, true);
        var query = U.query;
        U.query = U.search = null;
        URL = url.format(U);

        for (var i = 0; i < this.transforms.length; ++i) {
            var transform = this.transforms[i];
            var m = transform.pattern.exec(URL);
            if (m) {
                return {groups: m.slice(1), query: query, transform: transform};
            }
        }
    },

    _returnPosts: function(posts, render, cb) {
        if (render) {
            this.renderPosts(posts, cb);
        } else {
            cb(0, posts);
        }
    },

    renderPost: function(post, mode, cb) {
        // Performs nerve-specific parsing
        var transformer = new NerveTransformer(this);
        transformer.visit(post.tree);

        post.definitions = transformer.definitions
        if (post.definitions.icon) {
            post.icon = this.normalizeImageURL(post.definitions.icon);
        }

        if (mode == 'rss') {
            var rssTransformer = new RSSTransformer(this);
            rssTransformer.visit(post.tree);
        }

        // Asynchronously render each of the embeds
        async.mapSeries(transformer.embeds,
            _.bind(function(embed, cb2) {
                this.renderEmbed(embed, post, cb2);
            }, this),

            abind(function(err, embeds) {
                step2.apply(this);
            }, cb, this)
        );

        function step2() {
            async.mapSeries(transformer.figures, _.bind(function(node, cb2) {
                this._findScript(node.attributes['require'], _.bind(function(err, result) {
                    if (err) {
                        node.addClass('figureNotFound');
                        node.removeAttribute('figure');
                        node.removeAttribute('require');
                        cb2(0);
                    } else {
                        if (process.env.NODE_ENV == "production") {
                            node.setAttribute('timestamp', result.timestamp);
                        }
                        node.setAttribute('require', result.name);
                        cb2(0);
                    }
                }));
            }, this),
            _.bind(function(err) {
                step3.apply(this);
            }, this));
        }

        function step3() {
            var bodyProp = mode == 'rss' ? 'rssBody' : 'body';
            post[bodyProp] = markdom.toHTML(post.tree);

            if (post.stylesheetName) {
                this._findStylesheet(post.stylesheetName, _.bind(function(err, result) {
                    if (!err) {
                        var stylesheetURL = this.app.staticPath + '/' + result.path;
                        stylesheetURL = this.app.normalizeURL(stylesheetURL, null, result.timestamp);
                        post.stylesheets = [stylesheetURL];
                    }
                    cb(0, post);
                }, this));
            } else {
                cb(0, post);
            }
        }
    },

    renderPosts: function(posts, cb) {
        async.map(posts, _.bind(function(post, cb2) {
            this.renderPost(post, "html", abind(function(err, post) {
                var summary = summarizePost(post);
                post.description = summary.summary;

                this.renderPost(post, "rss", cb2);    
            }, cb, this));
        }, this), cb);
    },

    renderEmbed: function(embed, post, cb) {
        var key = embed.key();

        if (this.cache) {
            this.cache.load(key, _.bind(function(err, entry) {
                if (err || !entry) {
                    this._renderEmbed(key, embed, post, cb);
                } else {
                    var result = JSON.parse(entry.body);
                    embed.content = new Raw(result.content);
                    post.attach.apply(post, result.attachments);
                    cb(0, entry);
                    
                }
            }, this));
        } else {
            this._renderEmbed(key, embed, post, cb);            
        }
    },
    
    // *********************************************************************************************

    _findStylesheet: function(stylesheetName, cb) {
        // assert(this.app, "Can't include stylesheet without an app");

        var relativePath = './' + stylesheetName + '.css';
        appjs.searchScript(this.app.client, _.bind(function(err, result) {
            var searchPaths = [result.path];
            appjs.searchStatic(relativePath, searchPaths, _.bind(function(err, cssPath) {
                if (err) {
                    // Treat the stylesheet name as a top-level module
                    relativePath = names[0] + '/' + names[0] + '.css';
                    searchPaths = this.app.paths;
                    appjs.searchStatic(relativePath, searchPaths, function(err, cssPath) {
                        if (!err) {
                            returnResult.call(this, cssPath);
                        } else {
                            cb(err);
                        }
                    })                            
                } else {
                    returnResult.call(this, cssPath);
                }
            }, this));        
        }, this));

        function returnResult(stylesheetPath) {
            appjs.shortenStaticPath(stylesheetPath, abind(function(err, shortPath) {
                var result = {path: shortPath};
                fs.lstat(stylesheetPath, abind(function(err, stat) {
                    result.timestamp = stat.mtime.getTime();
                    cb(0, result);
                }, cb, this));
            }, cb, this));
        }
    },

    _findScript: function(scriptName, cb) {
        // assert(this.app, "Can't include script without an app");

        // First, look for script relative to client module
        var relativePath = './' + scriptName;
        var appSearchPaths = this.app.paths;
        appjs.searchScript(this.app.client, function(err, result) {
            var searchPaths = [result.path];
            appjs.searchScript(relativePath, searchPaths, function(err, result) {
                if (err) {
                    // Treat the script name as a top-level module
                    appjs.searchScript(scriptName, appSearchPaths, function(err, result) {
                        if (!err) {
                            returnResult(result);
                        } else {
                            cb(err);
                        }
                    })                            
                } else {
                    returnResult(result);
                }
            });        
        });

        function returnResult(result) {
            fs.lstat(result.path, abind(function(err, stat) {
                result.timestamp = stat.mtime.getTime();
                cb(0, result);
            }, cb, this));
        }
    },

    _renderEmbed: function(key, embed, post, cb) {
        // D&&D('render embed', key);
        embed.transform(post, abind(function(err, result) {
            if (err) return cb(err);
            
            var jsonResult = JSON.stringify(result);
            var entry = {
                key: key,
                body: jsonResult,
                mimeType: "application/json",
                charset: "UTF-8"
            };
            if (this.cache) {
                // XXXjoe Temporarily disable caching
                this.cache.store(key, entry);
            }

            if (result && result.content) {
                embed.content = new Raw(result.content);
            }
            if (result && result.attachments) {
                post.attach.apply(post, result.attachments);
            }
            cb(0, entry);
        }, cb, this));        
    },

    _findContent: function(cb) {
        if (this.contentPaths) {
            cb(0);
        } else {
            var directoryMap = {};
            var contentPaths = [];

            glob(this.contentPattern, 0, abind(function(err, matches) {
                async.map(matches, fs.lstat, abind(function(err, stats) {
                    _.each(stats, ibind(function(stat, i) {
                        if (stat.isDirectory() && !directoryMap[matches[i]]) {
                            contentPaths.push({path: matches[i], all: true});
                            directoryMap[matches[i]] = true;
                        } else {
                            var parentDir = path.dirname(matches[i]);
                            if (!directoryMap[parentDir]) {
                                contentPaths.push({path: parentDir, all: true});
                                directoryMap[parentDir] = true;
                            }
                        }
                    }, cb, this))
        
                    this.contentPaths = contentPaths;
                    cb(0);
                }, cb, this))
            }, cb, this));
        }
    },

    _assignConf: function(conf) {
        this.title = conf.title;
        this.description = conf.description;
        this.host = conf.host;
        this.templatesPath = conf.templates;
        this.contentPattern = fixPath(conf.content);
        this.postsPerPage = conf.postsPerPage || 10;
        this.searchPaths = conf.paths || [];

        this.api = new NerveAPI(this, conf.api || defaultApiPath);

        if (conf.cache) {
            this.cache = conf.cache;
        }

        if (conf.flickr) {
            var FlickrTransformer = require('./FlickrTransformer').FlickrTransformer;
            this.addTransform(new FlickrTransformer(conf.flickr.key, conf.flickr.secret));
        }

        var ImageTransformer = require('./ImageTransformer').ImageTransformer;
        this.addTransform(new ImageTransformer());

        // XXXjoe Not yet implemented
        // if (conf.facebook) {
        //     var FacebookTransformer = require('./FacebookTransformer').FacebookTransformer;
        //     this.addTransform(new FacebookTransformer(conf.facebook.key, conf.facebook.secret));
        // }
    },

    _parsePostsFile: function(filePath, cb) {
        fs.readFile(filePath, abind(function(err, fileBody) {
            this._statAndParsePosts(fileBody, filePath, cb);
        }, cb, this));
    },

    _statAndParsePosts: function(fileBody, filePath, cb) {
        fs.lstat(filePath, abind(function(err, stat) {
            this._parsePosts(fileBody, filePath, stat, cb);
        }, cb, this));
    },
    
    _parsePosts: function(fileBody, filePath, fileStat, cb) {
        var tree = markdom.toDOM(fileBody);

        var posts = [];
        var currentPost;
        for (var j = 0; j < tree.nodes.length; ++j) {
            var node = tree.nodes[j];
            if (node instanceof markdom.nodeTypes.Header && node.level == 1) {
                var header = node.content.toHTML();
                var info = this._parseHeader(header);
                
                var slug = info.title.toLowerCase().split(/\s+/).join('-');
                slug = slug.replace(/[^a-z0-9\-]/g, '');

                var dateSlug = info.date ? datetime.format(info.date, '%Y/%m/%d') : null;
                var relativeURL = info.group ? info.group : dateSlug + '/' + slug;
                if (currentPost) {
                    currentPost.source = currentPost.tree.toHTML();
                }

                currentPost = new Post(this);
                currentPost.title = info.title;
                currentPost.slug = slug;
                currentPost.mtime = fileStat.mtime;
                currentPost.path = filePath;
                currentPost.url = relativeURL;
                currentPost.date = info.date;
                currentPost.group = info.group;
                currentPost.tree = new markdom.nodeTypes.NodeSet([]);
                currentPost.postIndex = ++postIndex;
                currentPost.stylesheetName = info.stylesheetName;
                posts.push(currentPost);
            } else if (currentPost) {
                currentPost.tree.nodes.push(node);
            }
        }

        if (currentPost) {
            currentPost.source = currentPost.tree.toHTML();
        }

        if (cb) cb(0, posts);
    },
    
    _parseHeader: function(header) {
        var reStyle = /\(@(.*?)\)/;
        var reGroup = /\[(.*?)\]/;

        var title, stylesheetName, group, date;
        var result = {};

        var m = reStyle.exec(header);
        if (m && m[1]) {
            result.stylesheetName = m[1];
            header = header.replace(reStyle, '')
        }
        m = reGroup.exec(header);
        if (m && m[1]) {
            var date = new Date(m[1] + " " + defaultTimeZone);
            if (isNaN(date.getTime())) {
                result.group = m[1];
            } else {
                result.date = date;
            }

            header = header.replace(reGroup, '')
        } else {
            result.group = 'drafts';
        }

        result.title = header.trim();
        return result;
    },

    _postsAreEqual: function(a, b) {
        return a.title == b.title && a.source == b.source;
    },

    _removePost: function(oldPost, newPost) {
        var index = this.posts.indexOf(oldPost);
        if (newPost) {
            this.posts.splice(index, 1, newPost);
        } else {
            this.posts.splice(index, 1);
            
        }        
        this._assignPosts(this.posts);
    },

    _assignPosts: function(posts) {
        this.posts = posts;
        this.isInvalid = false;

        this.datedPosts = _.select(posts, function(post) {
            return post.date;
        });
        this.datedPosts.sort(function(a, b) {
            if (a.date > b.date) {
                return -1;
            } else {
                if (a.date < b.date) {
                    return 1;
                } else {
                    if (a.postIndex >= b.postIndex) {
                        return 1;
                    } else {
                        return -1;
                    }                
                }
            }
        });
        this.groupedPosts = groupArray(posts, function(post) {
            return post.group;
        });
    },
});

function urlJoin(a, b) {
    if (a[a.length-1] == '/' || b[0] == '/') {
        return a + b;
    } else {
        return a + '/' + b;
    }
}

function groupArray(items, cb) {
    var groups = {};
    for (var i = 0; i < items.length; ++i) {
        var name = cb(items[i], i);
        if (name) {
            var group = groups[name];
            if (group) {
                group.push(items[i]);
            } else {
                groups[name] = [items[i]];
            }
        }
    }
    return groups;
}

function fixPath(thePath) {
    return thePath.replace(/^~/, process.env.HOME);
}

/**
 * Used to prevent redundant calls from an in-progress asynchronous function.
 *
 * If you have an asynchronous function and it is called once and then called again before
 * the first call returns, aggregate prevents the second (and later) calls from happening,
 * but ensures that all callbacks are called when the first call completes.
 */
function aggregate(fn) {
    var callInProgress = false;
    var callbacks = [];

    return function() {
        // Expect the last argument to be a callback function
        var cb = arguments.length ? arguments[arguments.length-1] : null;
        if (cb && typeof(cb) == "function") {
            callbacks.push(cb);
        }

        var cleanup = _.bind(function() {
            // Call all of the callbacks that have aggregated while waiting
            // for the initial call to complete
            var args = arguments;
            callbacks.forEach(_.bind(function(callback) {
                callback.apply(this, args);
            }, this));

            callInProgress = false;
            callbacks = [];
        }, this);

        if (!callInProgress) {
            callInProgress = true;

            var args = [];
            for (var i = 0; i < arguments.length-1; ++i) {
                args.push(arguments[i]);
            }

            args.push(cleanup);
            fn.apply(this, args);
        }
    }    
}

function summarizePost(post) {
    var summarizer = new PostSummarizer();
    summarizer.visit(post.tree);
    return {summary: summarizer.summary, icon: summarizer.icon};
}
