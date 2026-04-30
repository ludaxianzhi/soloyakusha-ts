import {
  StyleLibraryService as CoreStyleLibraryService,
  type CreateStyleLibraryInput,
  type DeleteStyleLibraryResult,
  type StyleLibraryCatalog,
  type StyleLibraryImportResult,
  type StyleLibraryQueryResult,
} from '../../style-library/index.ts';

type WebStyleLibraryServiceOptions = {
  service?: CoreStyleLibraryService;
};

export class StyleLibraryService {
  private readonly service: CoreStyleLibraryService;

  constructor(options: WebStyleLibraryServiceOptions = {}) {
    this.service = options.service ?? new CoreStyleLibraryService();
  }

  async listVectorStoreNames(): Promise<string[]> {
    return await this.service.listVectorStoreNames();
  }

  async listLibraries(): Promise<StyleLibraryCatalog> {
    return await this.service.listLibraries();
  }

  async saveLibrary(
    name: string,
    input: CreateStyleLibraryInput,
  ) {
    return await this.service.createLibrary(name, input);
  }

  async importLibrary(
    name: string,
    input: {
      fileName: string;
      content: Uint8Array;
      formatName?: string;
    },
  ): Promise<StyleLibraryImportResult> {
    return await this.service.importLibrary(name, input);
  }

  async queryLibrary(name: string, text: string): Promise<StyleLibraryQueryResult> {
    return await this.service.queryLibrary(name, text);
  }

  async deleteLibrary(
    name: string,
    deleteCollection = true,
  ): Promise<DeleteStyleLibraryResult> {
    return await this.service.deleteLibrary({
      libraryName: name,
      deleteCollection,
    });
  }

  async deleteExternalCollection(input: {
    vectorStoreName: string;
    collectionName: string;
    deleteCollection?: boolean;
  }): Promise<DeleteStyleLibraryResult> {
    return await this.service.deleteLibrary(input);
  }
}