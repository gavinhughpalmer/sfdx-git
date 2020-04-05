import { core, flags, SfdxCommand } from '@salesforce/command';
import { AnyJson } from '@salesforce/ts-types';
import * as types from './types.json';
import {tmpdir} from 'os';
const decompress = require('decompress');
import * as fs from 'fs';
const sfdx = require('sfdx-js').Client.createUsingPath('sfdx');

// Initialize Messages with the current plugin directory
core.Messages.importMessagesDirectory(__dirname);

// TODO Refactoring and test classes...

interface MetadataType {
    name: string,
    members: string[]
}
interface Package {
    version: string,
    types: MetadataType[]
}

export default class Backup extends SfdxCommand {

    public static description = 'This command will perform a full backup of a given orgs metadata, simply provide the org and a full backup of metadata will be pulled into provided project folder';

    public static examples = [
        `$ sfdx gpalm:source:backup --targetusername myOrg@example.com
  Backup completed!
  `
    ];

    protected static flagsConfig = {
        packageversion: flags.number({char: 'v', description: 'Version number that the package.xml should use in the retrieve call', default: 42.0 }),
        outputdir: flags.string({ char: 'd', description: 'The directory where the source format should be output to', default: 'force-app' }),
        waittimemillis: flags.integer({ char: 'w', description: 'The wait time between retrieve checks', default: 1000 }),
        ignoretypes: flags.string({ char: 'i', description: 'Comma seperated list of any additional types that you wish to ignore from the retrieve process, this can be used if the error "The retrieved zip file exceeded the limit of 629145600 bytes. Total bytes retrieved: 629534861" is recieved'})
    };
    protected static requiresUsername = true;
    protected static supportsDevhubUsername = false;
    protected static requiresProject = true;
    private connection: core.Connection;
    private packageVersion: string;
    private retrieveFolder = tmpdir() + '/retrieve' + Date.now();

    public async run(): Promise<AnyJson> {
        this.connection = this.org.getConnection();
        this.packageVersion = this.flags.packageversion.toFixed(1);
        if (this.flags.ignoretypes) {
            types.ignore.push(...this.flags.ignoretypes.split(','));
        }
        this.ux.log('Ignoring: ' + types.ignore + ' from the backup job');
        // TODO Occational error with: ERROR running Backup:  getaddrinfo ENOTFOUND nccgroup.my.salesforce.com nccgroup.my.salesforce.com:443
        // this.ux.log(outputString);
        this.ux.log('Generating package...');
        const fullPackage = await this.buildPackage();
        await this.retrievePackage(fullPackage);
        // const firstPart = {...fullPackage};
        // firstPart.types = fullPackage.types.splice(0, fullPackage.types.length / 2);
        // await this.retrievePackage(firstPart);

        // const secondPart = {...fullPackage};
        // secondPart.types = fullPackage.types.splice(fullPackage.types.length / 2, fullPackage.types.length);
        // await this.retrievePackage(secondPart);

        // TODO what should be returned...
        return {};
    }

    private async retrievePackage(retrievePackage: Package) {
        const retrieveRequest = {
            unpackaged: retrievePackage
        };
        this.ux.log('Package built: ' + JSON.stringify(retrieveRequest.unpackaged, null, 2));
        this.connection.metadata.retrieve(retrieveRequest, (error, asyncResult) => {
            if (error) this.ux.log('An error has occured: ' + error.message);
            const checkStatus = async (error: Error, retrieveResult: any) => {
                if (error) this.ux.log('An error has occured: ' + error.message);
                this.ux.log(retrieveResult.status);
                if (retrieveResult.done === 'true' && retrieveResult.status !== 'Failed') {
                    await decompress(Buffer.from(retrieveResult.zipFile, 'base64'), this.retrieveFolder, {
                        map: function (file) {
                          const filePaths = file.path.split('/');
                          file.path = filePaths.join('/');
                          return file;
                        }
                    });
                    this.mkdir(this.flags.outputdir);
                    this.ux.startSpinner('Converting to source format...');
                    try {
                        await sfdx.mdapi.convert({
                            outputdir: this.flags.outputdir,
                            rootdir: this.retrieveFolder + '/unpackaged/',
                            json: true
                        });
                        this.ux.stopSpinner('Completed!');
                    } catch (error) {
                        this.ux.stopSpinner('Error!');
                        this.ux.log('An error has occured: ' + error.message);
                    }
                } else if (retrieveResult.done === 'true' && retrieveResult.status === 'Failed') {
                    this.ux.log('An error has occured: ' + retrieveResult.errorMessage);
                } else {
                    setTimeout(() => {
                        this.connection.metadata.checkRetrieveStatus(retrieveResult.id, checkStatus)
                    }, this.flags.waittimemillis)
                }
            }
            this.ux.log(`Job Id: ${asyncResult.id}`);
            this.connection.metadata.checkRetrieveStatus(asyncResult.id, checkStatus);
        });
    }

    private async buildPackage(): Promise<Package> {
        const makeLowerCase = (value: string) => value.toLowerCase();
        const wildcardTypes = new Set(types.wildcard.map(makeLowerCase));
        const ignoreTypes = new Set(types.ignore.map(makeLowerCase));

        const metadataDescribe = await this.connection.metadata.describe(this.packageVersion);
        const metadataPackage = {
            version: this.packageVersion,
            types: []
        };
        const packageMap = {};
        const metadataList = metadataDescribe.metadataObjects;
        const promises = [];
        for (let index in metadataList) {
            const metadataComponent = metadataList[index];
            const metadataTypeName = metadataComponent.xmlName.toLowerCase();
            if (ignoreTypes.has(metadataTypeName)) {
                continue;
            }
            if (wildcardTypes.has(metadataTypeName)) {
                metadataPackage.types.push({
                    name: metadataComponent.xmlName,
                    members: '*'
                });
            } else if (metadataTypeName === 'standardvalueset') {
                metadataPackage.types.push({
                    name: 'StandardValueSet',
                    members: types.standardValueSet
                });
            } else {
                promises.push(this.addComponent(packageMap, metadataComponent));
            }
        }
        await Promise.all(promises);
        this.buildPackageFromMap(metadataPackage, packageMap);
        return metadataPackage;
    }

    private buildPackageFromMap(metadataPackage, packageMap: object): void {
        for (let typeName in packageMap) {
            metadataPackage.types.push({
                name: typeName,
                members: packageMap[typeName]
            });
        }
    }

    private async addComponent(packageMap: object, metadataComponent): Promise<void> {
        let typeName = metadataComponent.xmlName;

        if (metadataComponent.inFolder) {
            typeName =
                typeName === 'EmailTemplate' ? 'EmailFolder' : typeName + 'Folder';
        }
        const types = [{ type: typeName, folder: null }];

        const metadataMembers = await this.connection.metadata.list(types, this.packageVersion);

        if (metadataMembers) {
            const members = packageMap[metadataComponent.xmlName] || [];
            const promises = [];
            for (let index in metadataMembers) {
                const member = metadataMembers[index];
                if (member.fullName && !metadataComponent.inFolder) {
                    members.push(member.fullName);
                } else if (member.fullName && metadataComponent.inFolder) {
                    promises.push(
                        this.listFolder(packageMap, metadataComponent.xmlName, member.fullName)
                    );
                }
            }
            packageMap[metadataComponent.xmlName] = members;
            if (promises.length !== 0) {
                await Promise.all(promises);
            }
        }
    }

    private async listFolder(packageMap: object, typeName: string, folderName: string): Promise<void> {
        const types = [{ type: typeName, folder: folderName }];
        const metadataMembers = await this.connection.metadata.list(types, this.packageVersion);
        if (!metadataMembers) return;
        const members = packageMap[typeName] || [];
        members.push(folderName);
        for (let index in metadataMembers) {
            if (metadataMembers[index].fullName) {
                members.push(metadataMembers[index].fullName);
            }
        }
        packageMap[typeName] = members;
    }

    private mkdir(path: string) {
        if (!fs.existsSync(path)) {
            fs.mkdirSync(path);
        }
    }
}
