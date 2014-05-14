(function() {

var fs = require('fs'),
    winston = require('winston'),
    async = require('async'),
    cheerio = require('cheerio'),
    mkdirp = require('mkdirp'),
    validator = require('validator');


var logger = new(winston.Logger)({
    transports: [
        new(winston.transports.Console)({
            // level: 'debug',
            prettyPrint: true,
            colorize: true,
            silent: false,
            timestamp: false
        })
    ]
});

var requestOptions = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:28.0) Gecko/20100101 Firefox/28.0'
    }
};
var request = require('request').defaults(requestOptions);


/** 可下载个人相册, 小站相册 */
var usage = "Usage: douban-photos-downloader album_url [other_album_urls]\n直接下载可能会有时";

/** 获取参数 */
var argv = require('minimist')(process.argv.slice(2));

async.eachSeries(argv._, function(album_url, cb) {

    /** validate */
    if (!validator.isURL(album_url)) {
        cb(album_url + 'is not url');
    }

    /** go to album's first page */
    var search_mark = album_url.indexOf('?');
    if (search_mark > 0) {
        album_url = album_url.slice(0, search_mark);
    }

    logger.info('开始处理 ' + album_url);

    var curr_page_url = album_url;
    var next_page_url = '';
    var photo_page_urls = [];
    var photo_img_srcs = [];
    var error_photo_img_srcs = [];
    var album_title = '';
    var page_photo_selector = '';
    var normal_photo_selector = '';
    if (curr_page_url.indexOf('widget') > 0) {
        // 小站相册
        logger.debug('site album');
        page_photo_selector = 'a.album_photo';
        normal_photo_selector = ".mainphoto img";
    } else {
        // 个人相册
        logger.debug('member album');
        page_photo_selector = 'a.photolst_photo';
        normal_photo_selector = ".image-show-inner img";
    }
    var large_photo_page_selector = ".report-link a";

    /** go to every page of the album */
    async.doUntil(

        /** page parser */
        function(cb) {

            async.waterfall([

                /** request this page */
                function(cb) {

                    logger.debug('requesting', curr_page_url);

                    request(curr_page_url, function(error, response, body) {
                        if (error) {
                            cb(new Error(error));
                        } else if (response.statusCode != 200) {
                            cb(new Error('status' + response.statusCode));
                        } else {
                            cb(null, curr_page_url, body);
                        }
                    });
                },
                /** get all photo page urls of this page */
                function(curr_page_url, body, cb) {

                    logger.debug('parsing', curr_page_url);

                    var $ = cheerio.load(body);

                    if (!album_title) {
                        album_title = $('title').text().trim();
                    }

                    $(page_photo_selector).map(function(index, element) {
                        photo_page_urls.push($(this).attr('href'));
                    });

                    /** 一页处理完, 再处理下一页: $('link[rel=next]').attr('href'); */
                    next_page_url = $('link[rel=next]').attr('href');
                    cb(null, next_page_url);
                }
            ], function(err, next_page_url) {
                curr_page_url = next_page_url;
                cb();
            });
        },
        /** tester */
        function() {
            logger.debug('next page is', next_page_url);
            return !next_page_url;
        },
        /** cb */
        function(err) {
            logger.info(album_title,
                '有 ' + photo_page_urls.length + ' 张图片');

            var photo_dir = 'photos/' + album_title;
            mkdirp.sync(photo_dir);

            async.eachSeries(photo_page_urls, function(photo_page_url, cb) {

                async.waterfall([
                    /** request photo page */
                    function(cb) {
                        logger.debug('request photo page', photo_page_url);
                        request(photo_page_url, function(error, response, body) {
                            if (error) {
                                cb(new Error(error));
                            } else if (response.statusCode != 200) {
                                cb(new Error('status' + response.statusCode));
                            } else {
                                cb(null, photo_page_url, body);
                            }
                        });
                    },
                    /** 解析 photo 页面 */
                    function(photo_page_url, body, cb) {
                        logger.debug('parsing photo page', photo_page_url);

                        var $ = cheerio.load(body),
                            large_photo_page = $(large_photo_page_selector).attr('href'),
                            normal_photo_src = $(normal_photo_selector).attr('src');

                        logger.debug('large photo page', large_photo_page);
                        logger.debug('normal photo src', normal_photo_src);

                        cb(null, large_photo_page, normal_photo_src);
                    },
                    /** 下载大图 */
                    function(large_photo_page, normal_photo_src, cb) {
                        if (!large_photo_page) {
                            cb(null, normal_photo_src);
			    return;
                        }

                        request(large_photo_page, function(error, response, body) {
                            if (error) {
                                cb(new Error(error));
                            } else if (response.statusCode != 200) {
                                cb(new Error('status' + response.statusCode));
                            } else {
                                var $ = cheerio.load(body),
                                    large_photo_src = $('#pic-viewer img').attr('src');

                                logger.debug('large photo src', large_photo_src);
                                cb(null, large_photo_src);
                            }
                        });
                    },
                    /** 下载 */
                    function(img, cb) {
                        logger.debug('downloading', img);

                        photo_img_srcs.push(img);

                        var img_file = photo_dir + '/' + img.slice(img.lastIndexOf('/') + 1);
                        var picStream = fs.createWriteStream(img_file);
                        picStream.on('close', function() {
                            logger.debug(img + ' downloaded');
                            cb();
                        });
                        var r = request(img);
                        r.on('error', function(err) {
                            logger.debug(img + ' download errored: ', err.code);
                            error_photo_img_srcs.push(img);
                            cb();
                        });
                        r.pipe(picStream);
                    }
                ], cb);
            }, function(err) {
                var photo_list = photo_dir + '/photos.ls';
                fs.writeFile(photo_list, photo_img_srcs.join("\n"), function(err) {
                    if (err) throw err;
                    logger.debug('photos.ls saved!');
                    logger.info(album_title, '下载完成', "所有图片的列表已保存至 " + photo_list);
                });
                if (error_photo_img_srcs) {
                    var error_list = photo_dir + '/photos.err.ls';
                    fs.writeFile(error_list, error_photo_img_srcs.join("\n"), function(err) {
                        if (err) throw err;
                        logger.debug('photos.err.ls saved!');
                        logger.error(album_title, "有 " + error_photo_img_srcs.length + '张图片下载失败',
                            '下载失败的图片列表已保存至 ' + error_list);
                    });
                }

		cb(); // next album
            });
        }
    );
}, function(err) {

    // if any of the file processing produced an error, err would equal that error
    if (err) {
        // One of the iterations produced an error.
        // All processing will now stop.
        console.log('A file failed to process');
    } else {
        console.log('All files have been processed successfully');
    }
});

}).call(this);

