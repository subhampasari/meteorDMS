import { Meteor }          from 'meteor/meteor';
import { FilesCollection } from 'meteor/ostrio:files';
import { _ } from 'meteor/underscore';
import { Random } from 'meteor/random';

import stream from 'stream';

import S3 from 'aws-sdk/clients/s3'; /* http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html */
import fs from 'fs';

const s3Conf = Meteor.settings.s3 || {};
const bound  = Meteor.bindEnvironment((callback) => {
  return callback();
});

const Images = new FilesCollection({
  debug: true,
  collectionName: 'images',
  allowClientCode: false, // Disallow remove files from Client
  onBeforeUpload: function (file) {
    // Allow upload files under 10MB
    if (file.size <= 1024 * 1024 * 10 ) {
      return true;
    }
    return 'Please upload image, with size equal or less than 10MB';
  },

  onAfterUpload(fileRef) {
    if(Meteor.isServer) {
      if (s3Conf && s3Conf.key && s3Conf.secret && s3Conf.bucket && s3Conf.region) {
      const s3 = new S3({
        secretAccessKey: s3Conf.secret,
        accessKeyId: s3Conf.key,
        region: s3Conf.region,
        httpOptions: {
          timeout: 6000,
          agent: false
        }
      });
      _.each(fileRef.versions, (vRef, version) => {
        const filePath = 'files/' + (Random.id()) + '-' + version + '.' + fileRef.extension;

        console.log("Test" + filePath.substring(filePath.indexOf("/")+1, filePath.indexOf("-")));
        s3.putObject({
          StorageClass: 'STANDARD',
          Bucket: s3Conf.bucket,
          Key: filePath,
          Body: fs.createReadStream(vRef.path),
          ContentType: vRef.type,
        }, (error) => {
          bound(() => {
            if (error) {
              console.error(error);
            } else {
              const upd = { $set: {} };
              upd['$set']['versions.' + version + '.meta.pipePath'] = filePath;

              this.collection.update({
                _id: fileRef._id
              }, upd, (updError) => {
                if (updError) {
                  console.error(updError);
                } else {
                  this.unlink(this.collection.findOne(fileRef._id), version);
                }
              });
            }
          });
        });
      });
    }
    else
    {
      throw new Meteor.Error(401, 'Missing Meteor file settings');
    }}},

    interceptDownload(http, fileRef, version) {
      if(Meteor.isServer) {
        if (s3Conf && s3Conf.key && s3Conf.secret && s3Conf.bucket && s3Conf.region) {
        const s3 = new S3({
          secretAccessKey: s3Conf.secret,
          accessKeyId: s3Conf.key,
          region: s3Conf.region,
          httpOptions: {
            timeout: 6000,
            agent: false
          }
        });
        let path;

        if (fileRef && fileRef.versions && fileRef.versions[version] && fileRef.versions[version].meta && fileRef.versions[version].meta.pipePath) {
          path = fileRef.versions[version].meta.pipePath;
        }

        if (path) {
          console.log("Path : " + path);
          const opts = {
            Bucket: s3Conf.bucket,
            Key: path
          };

          if (http.request.headers.range) {
            const vRef  = fileRef.versions[version];
            let range   = _.clone(http.request.headers.range);
            const array = range.split(/bytes=([0-9]*)-([0-9]*)/);
            const start = parseInt(array[1]);
            let end     = parseInt(array[2]);
            if (isNaN(end)) {
              end       = (start + this.chunkSize) - 1;
              if (end >= vRef.size) {
                end     = vRef.size - 1;
              }
            }
            opts.Range   = `bytes=${start}-${end}`;
            http.request.headers.range = `bytes=${start}-${end}`;
          }

          const fileColl = this;
          s3.getObject(opts, function (error) {
            if (error) {
              console.error(error);
              if (!http.response.finished) {
                http.response.end();
              }
            } else {
              if (http.request.headers.range && this.httpResponse.headers['content-range']) {
                http.request.headers.range = this.httpResponse.headers['content-range'].split('/')[0].replace('bytes ', 'bytes=');
              }

              const dataStream = new stream.PassThrough();
              fileColl.serve(http, fileRef, fileRef.versions[version], version, dataStream);
              dataStream.end(this.data.Body);
            }
          });

          return true;
        }
        return false;
      }
      else
      {
        throw new Meteor.Error(401, 'Missing Meteor file settings');
      }}
  },
});

const _origRemove = Images.remove;
Images.remove = function (search) {
  const cursor = this.collection.find(search);
  cursor.forEach((fileRef) => {
    _.each(fileRef.versions, (vRef) => {
      if (vRef && vRef.meta && vRef.meta.pipePath) {
        // Remove the object from AWS:S3 first, then we will call the original FilesCollection remove
        s3.deleteObject({
          Bucket: s3Conf.bucket,
          Key: vRef.meta.pipePath,
        }, (error) => {
          bound(() => {
            if (error) {
              console.error(error);
            }
          });
        });
      }
    });
  });
  _origRemove.call(this, search);
};



if (Meteor.isServer) {
  console.log("Checking server");
  Meteor.publish('files.images.all', function () {
    console.log("publishing");
    return Images.find({}).cursor;
  });
} 
if (Meteor.isClient) {
  console.log("subscribed");
  Meteor.subscribe('files.images.all');
}

export default Images;
